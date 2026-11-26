use image::{ImageReader, Limits, imageops::FilterType};
use sha1::{Digest, Sha1};
use std::{
    fs,
    io::{Cursor, Read},
    path::Path,
};
use zip::ZipArchive;

pub const MAX_COVER_RAW_BYTES: u64 = 64 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 20_000;
const MAX_DECODE_BYTES: u64 = 256 * 1024 * 1024;

pub struct Cover {
    pub pages: usize,
    pub sha1: String,
    pub key: String,
}

pub fn extract(
    zip_path: &Path,
    covers_dir: &Path,
    entry_id: &str,
    stamp: i64,
    size: u64,
) -> Result<Cover, String> {
    let file = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut images = Vec::new();
    for i in 0..archive.len() {
        let file = archive.by_index(i).map_err(|e| e.to_string())?;
        std::str::from_utf8(file.name_raw()).map_err(|_| "archive contains a non-UTF-8 path")?;
        let name = file.name().replace('\\', "/");
        if file.is_dir()
            || name
                .split('/')
                .any(|part| part == "__MACOSX" || part.starts_with("._"))
        {
            continue;
        }
        let ext = name
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .rsplit_once('.')
            .map(|x| x.1.to_ascii_lowercase());
        if matches!(ext.as_deref(), Some("jpg" | "jpeg" | "png" | "webp")) {
            images.push(name);
        }
    }
    images.sort_by(|a, b| natural_cmp(a, b));
    let first = images
        .first()
        .ok_or_else(|| "archive contains no supported images".to_string())?;
    let mut page = archive.by_name(first).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    page.by_ref()
        .take(MAX_COVER_RAW_BYTES + 1)
        .read_to_end(&mut raw)
        .map_err(|e| e.to_string())?;
    if raw.len() as u64 > MAX_COVER_RAW_BYTES {
        return Err("cover image exceeds the 64 MiB raw-byte limit".into());
    }
    let digest = hex::encode(Sha1::digest(&raw));
    let mut reader = ImageReader::new(Cursor::new(&raw))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|e| format!("cover decode failed: {e}"))?;
    let thumb = image.resize(400, 400, FilterType::Lanczos3).to_rgb8();
    let key = format!("{entry_id}-{stamp}-{size}.jpg");
    let temp = covers_dir.join(format!(".{key}.{}.tmp", uuid::Uuid::new_v4()));
    let final_path = covers_dir.join(&key);
    let result = (|| -> Result<(), String> {
        let mut output = fs::File::create(&temp).map_err(|e| e.to_string())?;
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 82)
            .encode_image(&image::DynamicImage::ImageRgb8(thumb))
            .map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temp, &final_path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result?;
    Ok(Cover {
        pages: images.len(),
        sha1: digest,
        key,
    })
}

fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let aa = a.to_ascii_lowercase();
    let bb = b.to_ascii_lowercase();
    let (mut i, mut j) = (0, 0);
    let (ab, bb) = (aa.as_bytes(), bb.as_bytes());
    while i < ab.len() && j < bb.len() {
        if ab[i].is_ascii_digit() && bb[j].is_ascii_digit() {
            let (si, sj) = (i, j);
            while i < ab.len() && ab[i].is_ascii_digit() {
                i += 1;
            }
            while j < bb.len() && bb[j].is_ascii_digit() {
                j += 1;
            }
            let mut x = si;
            let mut y = sj;
            while x + 1 < i && ab[x] == b'0' {
                x += 1;
            }
            while y + 1 < j && bb[y] == b'0' {
                y += 1;
            }
            let ord = (i - x).cmp(&(j - y)).then_with(|| ab[x..i].cmp(&bb[y..j]));
            if ord != Ordering::Equal {
                return ord;
            }
        } else {
            let ord = ab[i].cmp(&bb[j]);
            if ord != Ordering::Equal {
                return ord;
            }
            i += 1;
            j += 1;
        }
    }
    ab.len().cmp(&bb.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn natural_order_handles_numbers_and_case() {
        let mut names = vec!["10.JPG", "2.jpg", "01.jpg", "a.jpg"];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(names, vec!["01.jpg", "2.jpg", "10.JPG", "a.jpg"]);
    }
}
