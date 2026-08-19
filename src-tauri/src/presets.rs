//! Materials presets - reuse the same teaching text/files across models.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaterialFileRef {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaterialPreset {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub skill_name: String,
    #[serde(default)]
    pub skill_description: String,
    #[serde(default)]
    pub materials_text: String,
    #[serde(default)]
    pub material_files: Vec<MaterialFileRef>,
    pub updated_at: u64,
}

fn presets_dir() -> PathBuf {
    let settings = crate::settings::load();
    let primary = crate::settings::presets_dir(&settings);
    if primary.exists() {
        return primary;
    }
    // Portable stays in its own folder; do not pull installer profile presets.
    if crate::settings::is_portable() {
        return primary;
    }
    let legacy = crate::settings::legacy_presets_dir();
    if legacy.exists() {
        return legacy;
    }
    primary
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn list_material_presets() -> Vec<MaterialPreset> {
    let dir = presets_dir();
    let Ok(rd) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for ent in rd.flatten() {
        let path = ent.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(p) = serde_json::from_str::<MaterialPreset>(&text) {
                out.push(p);
            }
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

pub fn save_material_preset(mut preset: MaterialPreset) -> Result<MaterialPreset, String> {
    let dir = presets_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if preset.id.trim().is_empty() {
        preset.id = format!("p{}", now_secs());
    }
    if preset.name.trim().is_empty() {
        return Err("Give this preset a name.".into());
    }
    preset.updated_at = now_secs();
    let path = dir.join(format!("{}.json", sanitize_id(&preset.id)));
    let text = serde_json::to_string_pretty(&preset).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(preset)
}

pub fn delete_material_preset(id: String) -> Result<(), String> {
    let path = presets_dir().join(format!("{}.json", sanitize_id(&id)));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}
