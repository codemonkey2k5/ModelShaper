mod engine;
mod engine_bundle;
mod hw;
mod model_scan;
mod netutil;
mod presets;
mod settings;
mod win_cmd;

use engine::{EngineState, TrainRequest};
use settings::{AppSettings, SettingsState};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

#[tauri::command]
fn get_hardware_snapshot() -> hw::HardwareSnapshot {
    hw::snapshot()
}

#[tauri::command]
fn get_engine_status() -> engine::EngineStatus {
    let hw = hw::snapshot();
    let needs_driver = !hw.nvidia_smi_ok;
    engine::status(needs_driver)
}

#[tauri::command]
fn get_setup_plan(app: tauri::AppHandle) -> engine::SetupPlan {
    engine::setup_plan(&app)
}

#[tauri::command]
fn discover_runtimes(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    engine::discover_runtimes(&app)
}

#[tauri::command]
fn start_engine_setup(
    app: tauri::AppHandle,
    state: tauri::State<'_, EngineState>,
    repair: Option<bool>,
    python: String,
    allow_missing_install: Option<bool>,
) -> Result<(), String> {
    engine::start_setup(
        app,
        &state,
        repair.unwrap_or(false),
        python,
        allow_missing_install.unwrap_or(false),
    )
}

#[tauri::command]
fn cancel_engine_setup(state: tauri::State<'_, EngineState>) -> Result<(), String> {
    engine::cancel_setup(&state)
}

#[tauri::command]
fn mark_setup_idle(state: tauri::State<'_, EngineState>) -> Result<(), String> {
    engine::mark_setup_idle(&state);
    Ok(())
}

#[tauri::command]
fn scan_model(path: String) -> model_scan::ModelScanResult {
    model_scan::scan(&path)
}

#[tauri::command]
fn plan_training(
    model_path: String,
    power_mode: String,
    material_bytes: u64,
    skill_name: String,
) -> hw::TrainingPlan {
    let scan = model_scan::scan(&model_path);
    hw::plan_training(
        &model_path,
        &power_mode,
        material_bytes,
        &skill_name,
        scan.trainable,
        scan.estimated_params_b,
    )
}

#[tauri::command]
fn start_training(
    app: tauri::AppHandle,
    state: tauri::State<'_, EngineState>,
    request: TrainRequest,
) -> Result<(), String> {
    engine::start_training(app, &state, request)
}

#[tauri::command]
fn pause_training(state: tauri::State<'_, EngineState>) -> Result<(), String> {
    engine::pause_training(&state)
}

#[tauri::command]
fn resume_training(state: tauri::State<'_, EngineState>) -> Result<(), String> {
    engine::resume_training(&state)
}

#[tauri::command]
fn cancel_training(state: tauri::State<'_, EngineState>) -> Result<(), String> {
    engine::cancel_training(&state)
}

#[tauri::command]
fn download_hf_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, EngineState>,
    repo_id: String,
) -> Result<(), String> {
    engine::download_hf_model(app, &state, repo_id)
}

#[tauri::command]
fn cancel_download(state: tauri::State<'_, EngineState>) -> Result<(), String> {
    engine::cancel_download(&state)
}

#[tauri::command]
fn can_download() -> bool {
    engine::can_download()
}

#[tauri::command]
fn list_downloaded_models() -> Vec<model_scan::LocalPackage> {
    model_scan::list_downloaded_models()
}

#[tauri::command]
fn delete_downloaded_model(path: String) -> Result<(), String> {
    model_scan::delete_downloaded_model(&path)
}

#[tauri::command]
fn list_material_presets() -> Vec<presets::MaterialPreset> {
    presets::list_material_presets()
}

#[tauri::command]
fn save_material_preset(preset: presets::MaterialPreset) -> Result<presets::MaterialPreset, String> {
    presets::save_material_preset(preset)
}

#[tauri::command]
fn delete_material_preset(id: String) -> Result<(), String> {
    presets::delete_material_preset(id)
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    use std::path::PathBuf;
    use std::process::Command;
    let p = PathBuf::from(path.trim());
    if !p.exists() {
        return Err("That folder was not found on this PC.".into());
    }
    Command::new("explorer")
        .arg(if p.is_file() {
            format!("/select,{}", p.display())
        } else {
            p.display().to_string()
        })
        .spawn()
        .map_err(|e| format!("Could not open folder: {e}"))?;
    Ok(())
}

#[tauri::command]
fn get_app_settings(state: tauri::State<'_, SettingsState>) -> AppSettings {
    state.get()
}

#[tauri::command]
fn save_app_settings(
    state: tauri::State<'_, SettingsState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    state.set(settings.clone())?;
    Ok(settings)
}

#[tauri::command]
fn get_default_paths() -> serde_json::Value {
    settings::ensure_data_dirs();
    serde_json::json!({
        "models_dir": settings::default_models_dir().display().to_string(),
        "presets_dir": settings::default_presets_dir().display().to_string(),
        "engine_dir": settings::default_engine_dir().display().to_string(),
        "app_data": settings::app_data_root().display().to_string(),
        "portable": settings::is_portable(),
    })
}

/// Update tray hover text (e.g. training percent). No-op if tray missing.
#[tauri::command]
fn set_tray_tooltip(app: tauri::AppHandle, text: String) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        let tip = if text.trim().is_empty() {
            "ModelShaper".to_string()
        } else {
            format!("ModelShaper - {text}")
        };
        tray.set_tooltip(Some(&tip))
            .map_err(|e| format!("Could not update tray: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    show_window(&app);
    Ok(())
}

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Optional start screen for docs/screenshots: env MODELSHAPER_START_VIEW or
/// file `_start_view.txt` next to the data root (`help`, `settings`, `wizard`, `setup`).
#[tauri::command]
fn peek_start_view() -> Option<String> {
    if let Ok(v) = std::env::var("MODELSHAPER_START_VIEW") {
        let t = v.trim().to_lowercase();
        if !t.is_empty() {
            return Some(t);
        }
    }
    let p = settings::app_data_root().join("_start_view.txt");
    std::fs::read_to_string(p)
        .ok()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
}

#[tauri::command]
fn fetch_url_text(url: String) -> Result<String, String> {
    netutil::fetch_url_as_text(&url)
}

#[tauri::command]
fn check_for_update(
    state: tauri::State<'_, SettingsState>,
    manifest_url: Option<String>,
) -> Result<netutil::UpdateInfo, String> {
    let settings = state.get();
    let url = manifest_url
        .filter(|s| !s.trim().is_empty())
        .or(settings.update_manifest_url)
        .unwrap_or_default();
    netutil::check_for_update(&url)
}

fn show_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // Restore taskbar entry when coming back from tray-only mode.
        let _ = w.set_skip_taskbar(false);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn hide_to_tray(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // Without skip_taskbar, Windows can keep a taskbar button while the window is hidden.
        let _ = w.set_skip_taskbar(true);
        let _ = w.hide();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(EngineState::default())
        .manage(SettingsState::new())
        .invoke_handler(tauri::generate_handler![
            get_hardware_snapshot,
            get_engine_status,
            get_setup_plan,
            discover_runtimes,
            start_engine_setup,
            cancel_engine_setup,
            mark_setup_idle,
            scan_model,
            plan_training,
            start_training,
            pause_training,
            resume_training,
            cancel_training,
            download_hf_model,
            cancel_download,
            can_download,
            list_downloaded_models,
            delete_downloaded_model,
            list_material_presets,
            save_material_preset,
            delete_material_preset,
            open_folder,
            get_app_settings,
            save_app_settings,
            get_default_paths,
            set_tray_tooltip,
            show_main_window,
            get_app_version,
            peek_start_view,
            fetch_url_text,
            check_for_update
        ])
        .setup(|app| {
            // Create ModelShaper (or portable) folder tree and extract embedded engine.
            settings::ensure_data_dirs();
            let _ = engine_bundle::ensure_engine_pkg();

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("ModelShaper");
                let handle = app.handle().clone();
                // Guard against re-entry while we convert a minimize into a tray hide.
                let hiding = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                let hiding_ev = hiding.clone();
                window.on_window_event(move |event| {
                    let tray_mode = handle
                        .try_state::<SettingsState>()
                        .map(|s| s.get().minimize_to_tray)
                        .unwrap_or(true);
                    match event {
                        WindowEvent::CloseRequested { api, .. } => {
                            if tray_mode {
                                api.prevent_close();
                                hiding_ev.store(true, std::sync::atomic::Ordering::SeqCst);
                                hide_to_tray(&handle);
                                hiding_ev.store(false, std::sync::atomic::Ordering::SeqCst);
                            }
                        }
                        // Minimize button: Windows would keep a taskbar button; divert to tray.
                        WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
                            if !tray_mode || hiding_ev.load(std::sync::atomic::Ordering::SeqCst) {
                                return;
                            }
                            if let Some(w) = handle.get_webview_window("main") {
                                if w.is_minimized().unwrap_or(false) {
                                    hiding_ev.store(true, std::sync::atomic::Ordering::SeqCst);
                                    let _ = w.unminimize();
                                    hide_to_tray(&handle);
                                    hiding_ev.store(false, std::sync::atomic::Ordering::SeqCst);
                                }
                            }
                        }
                        _ => {}
                    }
                });
            }

            let show_i = MenuItem::with_id(app, "show", "Show ModelShaper", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit ModelShaper", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or_else(|| "Missing app icon for tray".to_string())?;

            let _tray = TrayIconBuilder::with_id("main")
                .icon(icon)
                .menu(&menu)
                .tooltip("ModelShaper")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_window(app),
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ModelShaper");
}
