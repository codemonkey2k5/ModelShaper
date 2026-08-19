//! Network helpers: page text for training materials, update manifest.
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub url: Option<String>,
    pub notes: Option<String>,
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(45))
        .user_agent(format!(
            "ModelShaper/{} (Windows)",
            env!("CARGO_PKG_VERSION")
        ))
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .map_err(|e| e.to_string())
}

/// Fetch a web page and return plain-ish text for training materials.
pub fn fetch_url_as_text(url: &str) -> Result<String, String> {
    let u = url.trim();
    if u.is_empty() {
        return Err("Enter a website address first.".into());
    }
    if !(u.starts_with("https://") || u.starts_with("http://")) {
        return Err("The address must start with https:// or http://".into());
    }
    let client = client()?;
    let resp = client
        .get(u)
        .send()
        .map_err(|e| format!("Could not reach that website: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "The website returned an error (status {}).",
            resp.status().as_u16()
        ));
    }
    let body = resp
        .text()
        .map_err(|e| format!("Could not read the page: {e}"))?;
    if body.len() > 8_000_000 {
        return Err("That page is too large to import.".into());
    }
    let mut s = body;
    for tag in ["script", "style", "noscript"] {
        s = strip_tag_blocks(&s, tag);
    }
    let text = html_to_text(&s);
    let cleaned = text.trim().to_string();
    if cleaned.len() < 40 {
        return Err(
            "Could not find enough readable text on that page. Try a different link, or paste the text yourself."
                .into(),
        );
    }
    Ok(cleaned)
}

fn strip_tag_blocks(html: &str, tag: &str) -> String {
    let open_l = format!("<{tag}").to_lowercase();
    let close_l = format!("</{tag}>").to_lowercase();
    let lower = html.to_lowercase();
    let mut out = String::new();
    let mut i = 0;
    while i < html.len() {
        if let Some(rel) = lower[i..].find(&open_l) {
            let start = i + rel;
            out.push_str(&html[i..start]);
            if let Some(rel2) = lower[start..].find(&close_l) {
                i = start + rel2 + close_l.len();
            } else {
                break;
            }
        } else {
            out.push_str(&html[i..]);
            break;
        }
    }
    if out.is_empty() && !html.is_empty() {
        return html.to_string();
    }
    out
}

fn html_to_text(html: &str) -> String {
    let mut s = html.to_string();
    for tag in [
        "br", "p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article",
    ] {
        let open = format!("<{tag}");
        s = s.replace(&open, &format!("\n{open}"));
        s = s.replace(&format!("</{tag}>"), "\n");
    }
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    let out = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    let mut result = String::new();
    let mut prev_space = false;
    let mut prev_nl = 0u8;
    for ch in out.chars() {
        if ch == '\r' {
            continue;
        }
        if ch == '\n' {
            if prev_nl < 2 {
                result.push('\n');
                prev_nl += 1;
            }
            prev_space = false;
            continue;
        }
        prev_nl = 0;
        if ch.is_whitespace() {
            if !prev_space {
                result.push(' ');
                prev_space = true;
            }
        } else {
            result.push(ch);
            prev_space = false;
        }
    }
    if result.len() > 400_000 {
        result.truncate(400_000);
        result.push_str("\n\n[Page text truncated for size.]");
    }
    result
}

#[derive(Deserialize)]
struct Manifest {
    version: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    notes: Option<String>,
}

pub fn check_for_update(manifest_url: &str) -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let url = manifest_url.trim();
    if url.is_empty() {
        return Ok(UpdateInfo {
            current_version: current.clone(),
            latest_version: current,
            update_available: false,
            url: None,
            notes: None,
        });
    }
    let client = client()?;
    let resp = client
        .get(url)
        .send()
        .map_err(|e| format!("Update check failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Update check failed (status {}).",
            resp.status().as_u16()
        ));
    }
    let man: Manifest = resp
        .json()
        .map_err(|e| format!("Update info was not readable: {e}"))?;
    let latest = man.version.trim().trim_start_matches('v').to_string();
    let update_available = cmp_semver(&latest, &current) > 0;
    Ok(UpdateInfo {
        current_version: current,
        latest_version: latest,
        update_available,
        url: man.url,
        notes: man.notes,
    })
}

fn cmp_semver(a: &str, b: &str) -> i32 {
    let pa: Vec<u32> = a.split('.').map(|x| x.parse().unwrap_or(0)).collect();
    let pb: Vec<u32> = b.split('.').map(|x| x.parse().unwrap_or(0)).collect();
    let n = pa.len().max(pb.len());
    for i in 0..n {
        let da = *pa.get(i).unwrap_or(&0);
        let db = *pb.get(i).unwrap_or(&0);
        if da > db {
            return 1;
        }
        if da < db {
            return -1;
        }
    }
    0
}
