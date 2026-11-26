use serde::Serialize;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GalleryRef {
    pub gid: String,
    pub token: String,
    pub domain: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub gid: String,
    pub token: String,
    pub domain: String,
    pub url: String,
    pub title: String,
}

#[derive(Clone, Debug)]
pub struct Metadata {
    pub title: Option<String>,
    pub title_jpn: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Clone)]
pub struct EhClient {
    http: reqwest::Client,
    credentialed_http: reqwest::Client,
    site_base: String,
    exhentai_base: String,
    api_base: String,
    interval: Duration,
    last_request: std::sync::Arc<Mutex<Option<Instant>>>,
}

impl EhClient {
    pub fn new(
        site_base: &str,
        api_base: &str,
        interval: Duration,
    ) -> Result<Self, reqwest::Error> {
        Self::with_bases(site_base, "https://exhentai.org", api_base, interval)
    }

    fn with_bases(
        site_base: &str,
        exhentai_base: &str,
        api_base: &str,
        interval: Duration,
    ) -> Result<Self, reqwest::Error> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::limited(5))
            .user_agent("Henshin/0.1 (personal library metadata lookup)")
            .build()?;
        let credentialed_http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("Henshin/0.1 (personal library metadata lookup)")
            .build()?;
        Ok(Self {
            http,
            credentialed_http,
            site_base: site_base.trim_end_matches('/').to_owned(),
            exhentai_base: exhentai_base.trim_end_matches('/').to_owned(),
            api_base: api_base.to_owned(),
            interval,
            last_request: Default::default(),
        })
    }

    async fn pace(&self) {
        let mut last = self.last_request.lock().await;
        if let Some(previous) = *last {
            tokio::time::sleep(self.interval.saturating_sub(previous.elapsed())).await;
        }
        *last = Some(Instant::now());
    }

    pub async fn lookup(
        &self,
        site: &str,
        cookie_header: Option<&str>,
        mode: &str,
        query: &str,
        include_expunged: bool,
    ) -> Result<Vec<Candidate>, (u16, String)> {
        let site_base = if site == "exhentai.org" {
            self.exhentai_base.as_str()
        } else {
            self.site_base.as_str()
        };
        let mut url = format!("{}/?", site_base);
        let pairs = if mode == "cover" {
            vec![
                ("f_shash", query.to_owned()),
                ("fs_similar", "on".into()),
                ("fs_covers", "on".into()),
            ]
        } else {
            vec![
                ("advsearch", "1".into()),
                ("f_sfu", "on".into()),
                ("f_sft", "on".into()),
                ("f_sfl", "on".into()),
                ("f_search", format!("\"{query}\"")),
            ]
        };
        url.push_str(
            &form_urlencoded::Serializer::new(String::new())
                .extend_pairs(pairs)
                .finish(),
        );
        if include_expunged {
            url.push_str("&f_sh=on");
        }
        self.pace().await;
        let client = if site == "exhentai.org" {
            &self.credentialed_http
        } else {
            &self.http
        };
        let mut request = client.get(url);
        if let Some(cookie) = lookup_cookie(site, cookie_header) {
            request = request.header(reqwest::header::COOKIE, cookie);
        }
        let response = request
            .send()
            .await
            .map_err(|e| (503, format!("E-Hentai request failed: {e}")))?;
        let status = response.status();
        if !status.is_success() {
            return Err((
                if status.as_u16() == 429 { 429 } else { 503 },
                format!("E-Hentai returned HTTP {}", status.as_u16()),
            ));
        }
        if !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .contains("html")
        {
            return Err((502, "E-Hentai returned a non-HTML response".into()));
        }
        let html = response
            .text()
            .await
            .map_err(|e| (502, format!("Could not read E-Hentai response: {e}")))?;
        let lower = html.to_ascii_lowercase();
        if [
            "rate limit",
            "temporarily banned",
            "ip address has been banned",
            "too many requests",
        ]
        .iter()
        .any(|s| lower.contains(s))
        {
            return Err((
                429,
                "E-Hentai is rate limiting requests; try again later".into(),
            ));
        }
        if html.trim().is_empty() {
            return Err((502, "E-Hentai returned an empty response".into()));
        }
        parse_candidates(&html, site_base)
    }

    pub async fn gdata(&self, galleries: &[GalleryRef]) -> Vec<Result<Metadata, String>> {
        let mut output = Vec::with_capacity(galleries.len());
        for chunk in galleries.chunks(25) {
            self.pace().await;
            let gidlist: Vec<(u64, &str)> = chunk
                .iter()
                .filter_map(|g| g.gid.parse::<u64>().ok().map(|id| (id, g.token.as_str())))
                .collect();
            if gidlist.len() != chunk.len() {
                output.extend(chunk.iter().map(|g| {
                    if g.gid.parse::<u64>().is_err() {
                        Err("Invalid gallery ID".into())
                    } else {
                        Err("Metadata request failed".into())
                    }
                }));
                continue;
            }
            let result = self
                .http
                .post(&self.api_base)
                .json(&json!({"method":"gdata", "gidlist":gidlist, "namespace":1}))
                .send()
                .await;
            let response = match result {
                Ok(r) if r.status().is_success() => r,
                Ok(r) => {
                    output.extend((0..chunk.len()).map(|_| {
                        Err(format!(
                            "E-Hentai metadata request returned HTTP {}",
                            r.status().as_u16()
                        ))
                    }));
                    continue;
                }
                Err(e) => {
                    output.extend(
                        (0..chunk.len())
                            .map(|_| Err(format!("E-Hentai metadata request failed: {e}"))),
                    );
                    continue;
                }
            };
            let value: Value = match response.json().await {
                Ok(v) => v,
                Err(e) => {
                    output.extend(
                        (0..chunk.len())
                            .map(|_| Err(format!("Invalid E-Hentai metadata response: {e}"))),
                    );
                    continue;
                }
            };
            if let Some(error) = value.get("error").and_then(Value::as_str) {
                output.extend((0..chunk.len()).map(|_| Err(error.to_owned())));
                continue;
            }
            let records = value
                .get("gmetadata")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for gallery in chunk {
                let expected_gid = normalize_gid(&gallery.gid);
                let same_gid = |record: &&Value| {
                    record
                        .get("gid")
                        .and_then(Value::as_u64)
                        .map(|n| n.to_string())
                        .as_deref()
                        == expected_gid.as_deref()
                };
                let success = records.iter().find(|record| {
                    same_gid(record)
                        && record
                            .get("token")
                            .and_then(Value::as_str)
                            .is_some_and(|token| token.eq_ignore_ascii_case(&gallery.token))
                });
                let result = success.or_else(|| {
                    records.iter().find(|record| {
                        same_gid(record)
                            && record.get("token").and_then(Value::as_str).is_none()
                            && record.get("error").and_then(Value::as_str).is_some()
                    })
                });
                output.push(
                    result
                        .map(parse_metadata)
                        .unwrap_or_else(|| Err("E-Hentai omitted this gallery".into())),
                );
            }
        }
        output
    }
}

fn lookup_cookie(site: &str, cookie_header: Option<&str>) -> Option<String> {
    if site != "exhentai.org" {
        return None;
    }
    let cookie = cookie_header?;
    let has_nw = cookie.split(';').any(|part| {
        part.trim()
            .split_once('=')
            .is_some_and(|(name, _)| name.trim() == "nw")
    });
    Some(if has_nw {
        cookie.to_owned()
    } else {
        format!("{cookie}; nw=1")
    })
}

pub fn parse_gallery_url(raw: &str) -> Result<GalleryRef, String> {
    let mut url =
        reqwest::Url::parse(raw).map_err(|_| "Enter a valid E-Hentai gallery URL".to_owned())?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err("Gallery URL must use HTTP or HTTPS".into());
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if !matches!(
        host.as_str(),
        "e-hentai.org" | "g.e-hentai.org" | "exhentai.org"
    ) {
        return Err("Only e-hentai.org and exhentai.org galleries are supported here".into());
    }
    let parts: Vec<String> = url
        .path_segments()
        .into_iter()
        .flatten()
        .map(str::to_owned)
        .collect();
    let gid = parts
        .get(1)
        .and_then(|raw| normalize_gid(raw))
        .ok_or_else(|| "Gallery URL must contain /g/<id>/<hex-token>/".to_owned())?;
    if parts.len() < 3
        || parts[0] != "g"
        || parts[2].is_empty()
        || !parts[2].bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err("Gallery URL must contain /g/<id>/<hex-token>/".into());
    }
    url.set_scheme("https")
        .map_err(|_| "Invalid gallery URL".to_owned())?;
    if host == "g.e-hentai.org" {
        url.set_host(Some("e-hentai.org"))
            .map_err(|_| "Invalid gallery host".to_owned())?;
    }
    let domain = if host == "exhentai.org" {
        "exhentai.org"
    } else {
        "e-hentai.org"
    };
    Ok(GalleryRef {
        gid,
        token: parts[2].to_ascii_lowercase(),
        domain: domain.into(),
    })
}

fn parse_candidates(html: &str, site_base: &str) -> Result<Vec<Candidate>, (u16, String)> {
    use scraper::{Html, Selector};
    let doc = Html::parse_document(html);
    let links = Selector::parse("a[href]").unwrap();
    let title_selector = Selector::parse(".glink").unwrap();
    let mut candidates = Vec::new();
    for link in doc.select(&links) {
        let Some(href) = link.value().attr("href") else {
            continue;
        };
        let absolute =
            reqwest::Url::parse(href).or_else(|_| reqwest::Url::parse(site_base)?.join(href));
        let Ok(absolute) = absolute else {
            continue;
        };
        let Ok(gallery) = parse_gallery_url(absolute.as_str()) else {
            continue;
        };
        if candidates
            .iter()
            .any(|c: &Candidate| c.gid == gallery.gid && c.token == gallery.token)
        {
            continue;
        }
        let title = link
            .select(&title_selector)
            .next()
            .map(|n| n.text().collect::<String>().trim().to_owned())
            .filter(|s| !s.is_empty())
            .or_else(|| link.value().attr("title").map(str::to_owned))
            .unwrap_or_else(|| link.text().collect::<String>().trim().to_owned());
        if title.is_empty() {
            continue;
        }
        candidates.push(Candidate {
            gid: gallery.gid.clone(),
            token: gallery.token.clone(),
            domain: gallery.domain.clone(),
            url: format!(
                "{}/g/{}/{}/",
                site_base.trim_end_matches('/'),
                gallery.gid,
                gallery.token
            ),
            title,
        });
    }
    let listing = Selector::parse("#galleries, .itg").unwrap();
    let no_results_marker = Selector::parse("#nohits, .nohits").unwrap();
    let body_text = doc
        .root_element()
        .text()
        .collect::<String>()
        .to_ascii_lowercase();
    let has_no_results_marker = doc.select(&no_results_marker).next().is_some()
        || body_text.contains("no hits found")
        || body_text.contains("no results found");
    if candidates.is_empty() && !has_no_results_marker && doc.select(&listing).next().is_none() {
        return Err((
            502,
            "E-Hentai returned an unexpected page; no search results were parsed".into(),
        ));
    }
    Ok(candidates)
}

pub(crate) fn normalize_gid(raw: &str) -> Option<String> {
    let id = raw.parse::<u64>().ok()?;
    (id > 0).then(|| id.to_string())
}

fn parse_metadata(record: &Value) -> Result<Metadata, String> {
    if let Some(error) = record.get("error").and_then(Value::as_str) {
        return Err(error.to_owned());
    }
    let title = record
        .get("title")
        .and_then(Value::as_str)
        .map(html_escape::decode_html_entities)
        .map(|s| s.into_owned());
    let title_jpn = record
        .get("title_jpn")
        .and_then(Value::as_str)
        .map(html_escape::decode_html_entities)
        .map(|s| s.into_owned());
    let mut tags: Vec<String> = record
        .get("tags")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_ascii_lowercase)
        .collect();
    if let Some(category) = record.get("category").and_then(Value::as_str) {
        tags.push(format!("category:{}", category.to_ascii_lowercase()));
    }
    tags.sort();
    tags.dedup();
    Ok(Metadata {
        title,
        title_jpn,
        tags,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    async fn mock_response(status: &str, content_type: &str, body: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 8192];
            let _ = stream.read(&mut request).await.unwrap();
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        format!("http://{address}")
    }

    async fn mock_request() -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 1024];
            loop {
                let count = stream.read(&mut chunk).await.unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let body = "<div class='itg'>No hits found</div>";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&request).into_owned()
        });
        (format!("http://{address}"), server)
    }

    async fn mock_redirect(location: String) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 1024];
            loop {
                let count = stream.read(&mut chunk).await.unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let response = format!(
                "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&request).into_owned()
        });
        (format!("http://{address}"), server)
    }

    #[test]
    fn parses_and_normalizes_eh_urls() {
        let parsed = parse_gallery_url("http://g.e-hentai.org/g/123/ABcd/?x=1").unwrap();
        assert_eq!(
            parsed,
            GalleryRef {
                gid: "123".into(),
                token: "abcd".into(),
                domain: "e-hentai.org".into()
            }
        );
        assert_eq!(
            parse_gallery_url("https://e-hentai.org/g/000123/ABcd/")
                .unwrap()
                .gid,
            "123"
        );
        assert_eq!(
            parse_gallery_url("https://exhentai.org/g/1/abc/")
                .unwrap()
                .domain,
            "exhentai.org"
        );
        assert!(parse_gallery_url("https://e-hentai.org/g/0/no/").is_err());
        assert!(parse_gallery_url("https://e-hentai.org/g/1/xyz!/").is_err());
    }
    #[test]
    fn parses_multiple_distinct_candidates_and_metadata() {
        let html = r#"<html><div class='itg'><a href='https://e-hentai.org/g/1/a1/'><div class='glink'>One &amp; Only</div></a><a href='https://e-hentai.org/g/2/b2/' title='Second'></a><a href='https://e-hentai.org/g/1/a1/'>duplicate</a></div></html>"#;
        let candidates = parse_candidates(html, "https://e-hentai.org").unwrap();
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].title, "One & Only");
        assert_eq!(candidates[1].title, "Second");
        assert!(
            parse_candidates(
                "<html><body>Galleries are temporarily unavailable</body></html>",
                "https://e-hentai.org"
            )
            .is_err()
        );
        assert!(
            parse_candidates(
                "<html><body><p>No hits found</p></body></html>",
                "https://e-hentai.org"
            )
            .unwrap()
            .is_empty()
        );
        let metadata = parse_metadata(&json!({"title":"A &amp; B", "title_jpn":"猫&#039;本", "category":"Non-H", "tags":["artist:Foo"]})).unwrap();
        assert_eq!(metadata.title.as_deref(), Some("A & B"));
        assert_eq!(metadata.title_jpn.as_deref(), Some("猫'本"));
        assert!(metadata.tags.contains(&"category:non-h".into()));
        assert!(metadata.tags.contains(&"artist:foo".into()));
    }

    #[tokio::test]
    async fn lookup_returns_all_candidates_and_distinguishes_empty_and_upstream_errors() {
        let base = mock_response("200 OK", "text/html", "<div class='itg'><a href='https://e-hentai.org/g/10/aa/'><div class='glink'>First</div></a><a href='https://e-hentai.org/g/11/bb/' title='Second'></a></div>").await;
        let client = EhClient::new(&base, &base, Duration::ZERO).unwrap();
        let candidates = client
            .lookup("e-hentai.org", None, "title", "sample", false)
            .await
            .unwrap();
        assert_eq!(
            candidates
                .iter()
                .map(|c| c.gid.as_str())
                .collect::<Vec<_>>(),
            vec!["10", "11"]
        );

        let base = mock_response(
            "200 OK",
            "text/html",
            "<div class='itg'>No hits found</div>",
        )
        .await;
        let client = EhClient::new(&base, &base, Duration::ZERO).unwrap();
        assert!(
            client
                .lookup("e-hentai.org", None, "title", "absent", false)
                .await
                .unwrap()
                .is_empty()
        );

        let base = mock_response("200 OK", "application/json", "{}").await;
        let client = EhClient::new(&base, &base, Duration::ZERO).unwrap();
        assert_eq!(
            client
                .lookup("e-hentai.org", None, "title", "sample", false)
                .await
                .unwrap_err()
                .0,
            502
        );

        let base = mock_response("429 Too Many Requests", "text/html", "wait").await;
        let client = EhClient::new(&base, &base, Duration::ZERO).unwrap();
        assert_eq!(
            client
                .lookup("e-hentai.org", None, "title", "sample", false)
                .await
                .unwrap_err()
                .0,
            429
        );
    }

    #[tokio::test]
    async fn gdata_maps_success_and_per_gallery_errors_to_the_requested_id() {
        let body = r#"{"gmetadata":[{"gid":1,"token":"aa","title":"A &amp; B","title_jpn":"猫&#039;本","category":"Non-H","tags":["artist:Foo"]},{"gid":2,"error":"gallery unavailable"}]}"#;
        let base = mock_response("200 OK", "application/json", body).await;
        let client = EhClient::new(&base, &base, Duration::ZERO).unwrap();
        let results = client
            .gdata(&[
                GalleryRef {
                    gid: "0001".into(),
                    token: "aa".into(),
                    domain: "e-hentai.org".into(),
                },
                GalleryRef {
                    gid: "2".into(),
                    token: "bb".into(),
                    domain: "e-hentai.org".into(),
                },
            ])
            .await;
        let metadata = results[0].as_ref().unwrap();
        assert_eq!(metadata.title.as_deref(), Some("A & B"));
        assert_eq!(metadata.title_jpn.as_deref(), Some("猫'本"));
        assert!(metadata.tags.contains(&"category:non-h".into()));
        assert_eq!(results[1].as_ref().unwrap_err(), "gallery unavailable");
    }

    #[tokio::test]
    async fn gdata_matches_shared_gallery_ids_by_token_and_keeps_tokenless_errors() {
        let body = r#"{"gmetadata":[{"gid":618395,"token":"0439fa3666","title":"Correct gallery","title_jpn":"正しい","category":"Non-H","tags":[]},{"gid":618395,"error":"invalid gallery token"}]}"#;
        let base = mock_response("200 OK", "application/json", body).await;
        let client = EhClient::new(&base, &base, Duration::ZERO).unwrap();
        let results = client
            .gdata(&[
                GalleryRef {
                    gid: "000618395".into(),
                    token: "0439fa3666".into(),
                    domain: "e-hentai.org".into(),
                },
                GalleryRef {
                    gid: "618395".into(),
                    token: "deadbeef00".into(),
                    domain: "e-hentai.org".into(),
                },
            ])
            .await;
        assert_eq!(
            results[0].as_ref().unwrap().title.as_deref(),
            Some("Correct gallery")
        );
        assert_eq!(results[1].as_ref().unwrap_err(), "invalid gallery token");
    }

    #[tokio::test]
    async fn gdata_splits_requests_at_twenty_five_galleries() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 8192];
                let _ = stream.read(&mut request).await.unwrap();
                let body = r#"{"gmetadata":[]}"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            }
            2
        });
        let base = format!("http://{address}");
        let client = EhClient::new("https://e-hentai.org", &base, Duration::ZERO).unwrap();
        let galleries = (1..=26)
            .map(|gid| GalleryRef {
                gid: gid.to_string(),
                token: "aa".into(),
                domain: "e-hentai.org".into(),
            })
            .collect::<Vec<_>>();
        let results = client.gdata(&galleries).await;
        assert_eq!(results.len(), 26);
        assert!(results.iter().all(Result::is_err));
        assert_eq!(server.await.unwrap(), 2);
    }

    #[tokio::test]
    async fn lookup_paces_consecutive_upstream_requests() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 8192];
                let _ = stream.read(&mut request).await.unwrap();
                let body = "<div class='itg'>No hits found</div>";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let base = format!("http://{address}");
        let client = EhClient::new(&base, &base, Duration::from_millis(50)).unwrap();
        let start = Instant::now();
        client
            .lookup("e-hentai.org", None, "title", "one", false)
            .await
            .unwrap();
        client
            .lookup("e-hentai.org", None, "title", "two", false)
            .await
            .unwrap();
        assert!(start.elapsed() >= Duration::from_millis(45));
        server.await.unwrap();
    }

    #[test]
    fn cookies_are_added_only_for_exhentai_and_keep_user_nw_value() {
        assert_eq!(lookup_cookie("e-hentai.org", Some("session=fixture")), None);
        assert_eq!(
            lookup_cookie("exhentai.org", Some("session=fixture")),
            Some("session=fixture; nw=1".into())
        );
        assert_eq!(
            lookup_cookie("exhentai.org", Some("session=fixture; nw=0")),
            Some("session=fixture; nw=0".into())
        );
    }

    #[tokio::test]
    async fn search_sends_cookies_only_to_exhentai() {
        let (eh_base, eh_server) = mock_request().await;
        let (exhentai_base, exhentai_server) = mock_request().await;
        let client =
            EhClient::with_bases(&eh_base, &exhentai_base, &eh_base, Duration::ZERO).unwrap();

        client
            .lookup(
                "e-hentai.org",
                Some("session=fictional-cookie"),
                "title",
                "sample",
                false,
            )
            .await
            .unwrap();
        client
            .lookup(
                "exhentai.org",
                Some("session=fictional-cookie"),
                "title",
                "sample",
                false,
            )
            .await
            .unwrap();

        let eh_request = eh_server.await.unwrap().to_ascii_lowercase();
        let exhentai_request = exhentai_server.await.unwrap().to_ascii_lowercase();
        assert!(!eh_request.contains("cookie:"));
        assert!(exhentai_request.contains("cookie: session=fictional-cookie; nw=1"));
    }

    #[tokio::test]
    async fn credentialed_search_does_not_follow_cross_origin_redirects() {
        let (target_base, mut target_server) = mock_request().await;
        let (exhentai_base, redirect_server) = mock_redirect(target_base).await;
        let client = EhClient::with_bases(
            "https://e-hentai.org",
            &exhentai_base,
            "https://api.e-hentai.org/api.php",
            Duration::ZERO,
        )
        .unwrap();

        let error = client
            .lookup(
                "exhentai.org",
                Some("session=fictional-cookie"),
                "title",
                "sample",
                false,
            )
            .await
            .unwrap_err();
        assert_eq!(error.0, 503);
        assert!(
            redirect_server
                .await
                .unwrap()
                .to_ascii_lowercase()
                .contains("cookie: session=fictional-cookie; nw=1")
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut target_server)
                .await
                .is_err()
        );
        target_server.abort();
    }
}
