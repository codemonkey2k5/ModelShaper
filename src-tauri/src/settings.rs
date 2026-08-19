//! User preferences (paths, tray, theme).
//!
//! Installed builds store data under LocalAppData\ModelShaper.
//! Portable (standalone) builds store data next to ModelShaper.exe.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::OnceLock;

const APP_FOLDER: &str = "ModelShaper";
/// Prior product folder - still read as a fallback so existing data is found.
const LEGACY_FOLDER: &str = "ModelCraft";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallMode {
    /// NSIS/MSI (or other) install → LocalAppData\ModelShaper
    Installed,
    /// Standalone EXE → folders next to the executable
    Portable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    /// Close (X) and minimize both hide to tray instead of quitting / taskbar.
    pub minimize_to_tray: bool,
    pub dark_mode: bool,
    /// Override for downloaded model packages (null = default).
    pub models_dir: Option<String>,
    /// Default export folder for new training jobs.
    pub export_dir: Option<String>,
    /// Override for materials presets folder.
    pub presets_dir: Option<String>,
    /// Optional JSON URL for update checks: { "version", "url", "notes" }.
    pub update_manifest_url: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            minimize_to_tray: true,
            dark_mode: false,
            models_dir: None,
            export_dir: None,
            presets_dir: None,
            update_manifest_url: None,
        }
    }
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

/// True when this looks like a full install under Programs / Program Files.
fn looks_installed(dir: &Path) -> bool {
    let lower = dir.to_string_lossy().to_lowercase();
    lower.contains(r"\program files\")
        || lower.contains(r"\program files (x86)\")
        || lower.contains(r"\appdata\local\programs\")
        || lower.contains(r"\appdata\roaming\microsoft\windows\start menu\")
}

/// Cached install mode for the process lifetime.
///
/// Installed Setup/MSI → LocalAppData\ModelShaper.
/// Lone ModelShaper.exe anywhere else → data next to the EXE.
/// No marker files or extra sidecars required.
pub fn install_mode() -> InstallMode {
    static MODE: OnceLock<InstallMode> = OnceLock::new();
    *MODE.get_or_init(|| {
        let Some(dir) = exe_dir() else {
            return InstallMode::Installed;
        };
        if looks_installed(&dir) {
            return InstallMode::Installed;
        }
        // Cargo / Tauri build output still uses the profile folder (dev convenience).
        let lower = dir.to_string_lossy().to_lowercase();
        if lower.contains(r"\target\release") || lower.contains(r"\target\debug") {
            return InstallMode::Installed;
        }
        InstallMode::Portable
    })
}

pub fn is_portable() -> bool {
    install_mode() == InstallMode::Portable
}

fn local_profile_root() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_FOLDER)
}

fn legacy_profile_root() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(LEGACY_FOLDER)
}

/// App data root: portable → EXE folder; installed → LocalAppData\ModelShaper.
/// Never uses ModelCraft as the write root (legacy is read-only fallback elsewhere).
pub fn app_data_root() -> PathBuf {
    match install_mode() {
        InstallMode::Portable => exe_dir().unwrap_or_else(|| PathBuf::from(".")),
        InstallMode::Installed => local_profile_root(),
    }
}

/// Copy settings from legacy ModelCraft once if ModelShaper has none yet.
fn migrate_legacy_settings_if_needed(root: &Path) {
    if is_portable() {
        return;
    }
    let neu_settings = root.join("settings.json");
    if neu_settings.exists() {
        return;
    }
    let old_settings = legacy_profile_root().join("settings.json");
    if !old_settings.exists() {
        return;
    }
    let _ = fs::create_dir_all(root);
    let _ = fs::copy(&old_settings, &neu_settings);
}

/// Create models / presets / engine under the active root.
pub fn ensure_data_dirs() {
    let root = app_data_root();
    migrate_legacy_settings_if_needed(&root);
    for name in ["models", "presets", "engine"] {
        let _ = fs::create_dir_all(root.join(name));
    }
}

pub fn settings_path() -> PathBuf {
    app_data_root().join("settings.json")
}

pub fn default_models_dir() -> PathBuf {
    app_data_root().join("models")
}

pub fn default_presets_dir() -> PathBuf {
    app_data_root().join("presets")
}

pub fn default_engine_dir() -> PathBuf {
    app_data_root().join("engine")
}

/// Legacy ModelCraft paths (installed profile only) for read fallbacks.
pub fn legacy_models_dir() -> PathBuf {
    legacy_profile_root().join("models")
}

pub fn legacy_presets_dir() -> PathBuf {
    legacy_profile_root().join("presets")
}

pub fn legacy_engine_dir() -> PathBuf {
    legacy_profile_root().join("engine")
}

pub fn load() -> AppSettings {
    ensure_data_dirs();
    let path = settings_path();
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(s) = serde_json::from_str::<AppSettings>(&text) {
            return s;
        }
    }
    AppSettings::default()
}

pub fn save(settings: &AppSettings) -> Result<(), String> {
    let root = app_data_root();
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let path = settings_path();
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn models_dir(settings: &AppSettings) -> PathBuf {
    settings
        .models_dir
        .as_ref()
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(default_models_dir)
}

pub fn presets_dir(settings: &AppSettings) -> PathBuf {
    settings
        .presets_dir
        .as_ref()
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(default_presets_dir)
}

/// In-memory mirror so tray close handler can read without disk I/O races.
pub struct SettingsState(pub Mutex<AppSettings>);

impl SettingsState {
    pub fn new() -> Self {
        Self(Mutex::new(load()))
    }

    pub fn get(&self) -> AppSettings {
        self.0
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    pub fn set(&self, s: AppSettings) -> Result<(), String> {
        save(&s)?;
        if let Ok(mut g) = self.0.lock() {
            *g = s;
        }
        Ok(())
    }
}
