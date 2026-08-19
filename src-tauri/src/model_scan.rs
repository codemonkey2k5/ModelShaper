use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelFormat {
    Huggingface,
    Gguf,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelScanResult {
    pub path: String,
    pub format: ModelFormat,
    pub display_name: String,
    pub size_bytes: Option<u64>,
    pub trainable: bool,
    pub message: String,
    /// Short tip for non-experts (shown in UI).
    pub help_tip: String,
    pub estimated_params_b: Option<f32>,
    /// Best-effort name guessed from a GGUF filename for search help.
    pub suggested_search: Option<String>,
}

pub fn scan(path: &str) -> ModelScanResult {
    let p = Path::new(path);
    let display_name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());

    if !p.exists() {
        return ModelScanResult {
            path: path.to_string(),
            format: ModelFormat::Unknown,
            display_name,
            size_bytes: None,
            trainable: false,
            message: "That location was not found.".into(),
            help_tip: "Use Browse and pick a folder or file that still exists on this PC.".into(),
            estimated_params_b: None,
            suggested_search: None,
        };
    }

    if p.is_file() {
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let size = fs::metadata(p).ok().map(|m| m.len());
        if ext == "gguf" {
            let search = guess_search_name(&display_name);
            return ModelScanResult {
                path: path.to_string(),
                format: ModelFormat::Gguf,
                display_name,
                size_bytes: size,
                trainable: false,
                message: "This is a single chat-ready file. ModelShaper can teach a model only when you give it the full model package (a folder of files), not only this one file.".into(),
                help_tip: "Chat apps often use these single files. For teaching, download the full model package from the same place you got this one (often a folder named after the model). Abliterated / uncensored models work the same way - you need their full package folder, not only the single file. After training, ModelShaper can write a chat-ready file for you; you do not need to build that yourself.".into(),
                estimated_params_b: guess_params(path),
                suggested_search: search,
            };
        }
        return ModelScanResult {
            path: path.to_string(),
            format: ModelFormat::Unknown,
            display_name,
            size_bytes: size,
            trainable: false,
            message: "This does not look like a model ModelShaper can use yet.".into(),
            help_tip: "Choose a model folder, or a single chat-ready file so we can explain what else you need.".into(),
            estimated_params_b: None,
            suggested_search: None,
        };
    }

    // Directory
    let config = p.join("config.json");
    let has_weights = dir_has_weights(p);
    let size = dir_size_approx(p);
    let has_gguf = folder_has_gguf(p);

    if config.exists() && has_weights {
        return ModelScanResult {
            path: path.to_string(),
            format: ModelFormat::Huggingface,
            display_name,
            size_bytes: size,
            trainable: true,
            message: "This looks like a full model package. ModelShaper can teach it.".into(),
            help_tip: "You can continue. After training, ModelShaper can save a version that works in common chat apps.".into(),
            estimated_params_b: guess_params(path),
            suggested_search: None,
        };
    }

    if config.exists() {
        return ModelScanResult {
            path: path.to_string(),
            format: ModelFormat::Huggingface,
            display_name,
            size_bytes: size,
            trainable: true,
            message: "This folder looks like a model package. Weight files were not fully confirmed, but you can try it.".into(),
            help_tip: "If training fails, make sure the folder is fully downloaded.".into(),
            estimated_params_b: guess_params(path),
            suggested_search: None,
        };
    }

    if has_gguf {
        let search = guess_search_name(&display_name);
        return ModelScanResult {
            path: path.to_string(),
            format: ModelFormat::Gguf,
            display_name,
            size_bytes: size,
            trainable: false,
            message: "This folder only has chat-ready files. ModelShaper needs the full model package to teach.".into(),
            help_tip: "Look for a download that is a complete model folder (many files), not only chat-ready files. Abliterated models are fine when you have their full package.".into(),
            estimated_params_b: guess_params(path),
            suggested_search: search,
        };
    }

    ModelScanResult {
        path: path.to_string(),
        format: ModelFormat::Unknown,
        display_name,
        size_bytes: size,
        trainable: false,
        message: "ModelShaper could not recognize a model here.".into(),
        help_tip: "Pick the folder that contains the model’s main files (often including something like config and large weight files).".into(),
        estimated_params_b: guess_params(path),
        suggested_search: None,
    }
}

/// Turn "Something-7B-Instruct-Q4_K_M.gguf" into a cleaner search phrase.
fn guess_search_name(filename: &str) -> Option<String> {
    let mut s = filename.to_string();
    if let Some(i) = s.rfind('.') {
        s = s[..i].to_string();
    }
    // Strip common quant suffixes
    let lower = s.to_lowercase();
    for token in [
        "-q2_k", "-q3_k", "-q3_k_m", "-q3_k_s", "-q4_0", "-q4_1", "-q4_k", "-q4_k_m", "-q4_k_s",
        "-q5_0", "-q5_1", "-q5_k", "-q5_k_m", "-q5_k_s", "-q6_k", "-q8_0", "-f16", "-f32",
        "_q2_k", "_q3_k", "_q4_k_m", "_q5_k_m", "_q6_k", "_q8_0", ".q4_k_m", ".q5_k_m",
        "-iq4", "-iq3", "-gguf",
    ] {
        if let Some(idx) = lower.find(token) {
            s = s[..idx].to_string();
            break;
        }
    }
    let s = s.trim_matches(|c| c == '-' || c == '_' || c == '.').to_string();
    if s.len() < 3 {
        None
    } else {
        Some(s)
    }
}

fn dir_has_weights(p: &Path) -> bool {
    let Ok(rd) = fs::read_dir(p) else {
        return false;
    };
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().to_lowercase();
        if name.ends_with(".safetensors")
            || name.ends_with(".bin")
            || name == "pytorch_model.bin.index.json"
            || name.contains("safetensors")
        {
            return true;
        }
    }
    false
}

fn folder_has_gguf(p: &Path) -> bool {
    let Ok(rd) = fs::read_dir(p) else {
        return false;
    };
    rd.flatten().any(|e| {
        e.path()
            .extension()
            .and_then(|x| x.to_str())
            .map(|x| x.eq_ignore_ascii_case("gguf"))
            .unwrap_or(false)
    })
}

fn dir_size_approx(p: &Path) -> Option<u64> {
    let mut total = 0u64;
    let mut stack = vec![p.to_path_buf()];
    let mut files = 0u32;
    while let Some(cur) = stack.pop() {
        let Ok(rd) = fs::read_dir(&cur) else {
            continue;
        };
        for ent in rd.flatten() {
            let path = ent.path();
            if path.is_dir() {
                if files < 500 {
                    stack.push(path);
                }
            } else if let Ok(meta) = ent.metadata() {
                total = total.saturating_add(meta.len());
                files += 1;
                if files > 2000 {
                    return Some(total);
                }
            }
        }
    }
    Some(total)
}

fn guess_params(path: &str) -> Option<f32> {
    let lower = path.to_lowercase();
    for (k, v) in [
        ("70b", 70.0f32),
        ("34b", 34.0),
        ("32b", 32.0),
        ("14b", 14.0),
        ("13b", 13.0),
        ("12b", 12.0),
        ("9b", 9.0),
        ("8b", 8.0),
        ("7b", 7.0),
        ("3b", 3.0),
        ("1b", 1.0),
        ("0.6b", 0.6),
        ("1.7b", 1.7),
        ("4b", 4.0),
    ] {
        if lower.contains(k) {
            return Some(v);
        }
    }
    None
}

/// Package already saved under ModelShaper models (profile or portable).
#[derive(Debug, Clone, Serialize)]
pub struct LocalPackage {
    pub path: String,
    pub folder_name: String,
    /// Hugging Face style id if folder used repo__name convention.
    pub hf_repo: Option<String>,
    pub size_bytes: Option<u64>,
    pub trainable: bool,
    pub complete: bool,
}

/// Model folders to scan for "On this PC" packages.
///
/// Standalone (portable) builds only use the models folder next to the EXE
/// (or an explicit Settings override). They must not see installer / profile downloads.
fn models_roots() -> Vec<PathBuf> {
    let settings = crate::settings::load();
    let mut roots = vec![crate::settings::models_dir(&settings)];
    // Installed builds may still find older ModelCraft downloads.
    // Portable builds stay isolated to their own folder tree.
    if !crate::settings::is_portable() {
        let legacy = crate::settings::legacy_models_dir();
        if legacy.exists() && !roots.iter().any(|r| r == &legacy) {
            roots.push(legacy);
        }
    }
    roots
}

/// List packages downloaded by ModelShaper (or dropped into its models folder).
pub fn list_downloaded_models() -> Vec<LocalPackage> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for root in models_roots() {
        let Ok(rd) = fs::read_dir(&root) else {
            continue;
        };
        for ent in rd.flatten() {
            let path = ent.path();
            if !path.is_dir() {
                continue;
            }
            let key = path.display().to_string().to_lowercase();
            if !seen.insert(key) {
                continue;
            }
            let name = ent.file_name().to_string_lossy().to_string();
            if name.starts_with('_') {
                continue;
            }
            let has_cfg = path.join("config.json").is_file();
            let has_weights = dir_has_weights(&path);
            let complete = has_cfg && has_weights;
            if !has_cfg && !has_weights {
                continue;
            }
            let hf_repo = if name.contains("__") {
                Some(name.replace("__", "/"))
            } else {
                None
            };
            out.push(LocalPackage {
                path: path.display().to_string(),
                folder_name: name,
                hf_repo,
                size_bytes: dir_size_approx(&path),
                trainable: complete,
                complete,
            });
        }
    }
    out.sort_by(|a, b| a.folder_name.to_lowercase().cmp(&b.folder_name.to_lowercase()));
    out
}

/// Delete a package under an allowed models folder only (safety).
pub fn delete_downloaded_model(path: &str) -> Result<(), String> {
    let p = PathBuf::from(path.trim());
    if !p.exists() {
        return Err("That folder was not found.".into());
    }
    let canon = p.canonicalize().map_err(|e| e.to_string())?;
    let allowed: Vec<PathBuf> = models_roots()
        .into_iter()
        .filter_map(|r| r.canonicalize().ok().or(Some(r)))
        .collect();
    let ok = allowed.iter().any(|root| canon.starts_with(root) && &canon != root);
    if !ok {
        return Err("Only packages inside ModelShaper's models folders can be deleted here.".into());
    }
    if canon.is_dir() {
        fs::remove_dir_all(&canon).map_err(|e| format!("Could not delete package: {e}"))?;
    } else {
        fs::remove_file(&canon).map_err(|e| format!("Could not delete file: {e}"))?;
    }
    Ok(())
}
