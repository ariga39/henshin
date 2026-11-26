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
    site_base: String,
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
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::limited(5))
            .user_agent("Henshin/0.1 (personal library metadata lookup)")
            .build()?;
        Ok(Self {
            http,
            site_base: site_base.trim_end_matches('/').to_owned(),
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
        mode: &str,
        query: &str,
        include_expunged: bool,
    ) -> Result<Vec<Candidate>, (u16, String)> {
        let mut url = format!("{}/?", self.site_base);
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
        let response = self
            .http
            .get(url)
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
        parse_candidates(&html, &self.site_base)
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
                let record = records.iter().find(|r| {
                    r.get("gid")
                        .and_then(Value::as_u64)
                        .map(|n| n.to_string())
                        .as_deref()
                        == Some(gallery.gid.as_str())
                });
                output.push(
                    record
                        .map(parse_metadata)
                        .unwrap_or_else(|| Err("E-Hentai omitted this gallery".into())),
                );
            }
        }
        output
    }
}

pub fn parse_gallery_url(raw: &str) -> Result<GalleryRef, String> {
    let mut url =
        reqwest::Url::parse(raw).map_err(|_| "Enter a valid E-Hentai gallery URL".to_owned())?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err("Gallery URL must use HTTP or HTTPS".into());
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if !matches!(host.as_str(), "e-hentai.org" | "g.e-hentai.org") {
        return Err("Only e-hentai.org galleries are supported here".into());
    }
    let parts: Vec<String> = url
        .path_segments()
        .into_iter()
        .flatten()
        .map(str::to_owned)
        .collect();
    if parts.len() < 3
        || parts[0] != "g"
        || parts[1].is_empty()
        || parts[2].is_empty()
        || !parts[1].bytes().all(|c| c.is_ascii_digit())
        || parts[1].parse::<u64>().unwrap_or(0) == 0
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
    Ok(GalleryRef {
        gid: parts[1].to_owned(),
        token: parts[2].to_ascii_lowercase(),
        domain: "e-hentai.org".into(),
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
    if candidates.is_empty()
        && !html.to_ascii_lowercase().contains("galleries")
        && !html.contains("No hits found")
        && !html.contains("No results")
    {
        return Err((
            502,
            "E-Hentai returned an unexpected page; no search results were parsed".into(),
        ));
    }
    Ok(candidates)
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
        assert!(parse_gallery_url("https://exhentai.org/g/1/abc/").is_err());
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
        let metadata = parse_metadata(&json!({"title":"A &amp; B", "title_jpn":"猫&#039;本", "category":"Non-H", "tags":["artist:Foo"]})).unwrap();
        assert_eq!(metadata.title.as_deref(), Some("A & B"));
        assert_eq!(metadata.title_jpn.as_deref(), Some("猫'本"));
        assert!(metadata.tags.contains(&"category:non-h".into()));
        assert!(metadata.tags.contains(&"artist:foo".into()));
    }
}
