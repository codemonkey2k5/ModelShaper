use crate::win_cmd;
use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize)]
pub struct EngineStatus {
    pub installed: bool,
    pub healthy: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub message: String,
    pub needs_setup: bool,
    pub needs_driver: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SetupComponent {
    pub id: String,
    pub name: String,
    pub description: String,
    pub size_mb: u32,
    /// If true, this is already present on the selected runtime and will NOT be installed.
    pub already_present: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeCandidate {
    pub executable: String,
    pub version: Option<String>,
    pub ok: bool,
    pub supported: bool,
    pub has_train_stack: bool,
    pub ready_for_training: bool,
    pub cuda_available: bool,
    pub cuda_device: Option<String>,
    pub present: Vec<String>,
    pub missing: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SetupPlan {
    pub components: Vec<SetupComponent>,
    pub install_dir: String,
    pub estimated_download_mb: u32,
    pub needs_internet: bool,
    pub notes: Vec<String>,
    pub policy: Vec<String>,
    pub runtimes: Vec<RuntimeCandidate>,
    pub recommended_python: Option<String>,
    /// Packages missing from the recommended runtime (pip names).
    pub missing_on_recommended: Vec<String>,
    pub can_link_without_install: bool,
    /// Set when runtime discovery itself failed (not merely "no Python found").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discovery_error: Option<String>,
}

pub struct EngineState {
    pub setup_running: Mutex<bool>,
    pub setup_cancel: Arc<AtomicBool>,
    pub train_child_kill: Mutex<Option<u32>>, // process id
    pub download_child_kill: Mutex<Option<u32>>,
    pub control_dir: Mutex<Option<PathBuf>>,
}

impl Default for EngineState {
    fn default() -> Self {
        Self {
            setup_running: Mutex::new(false),
            setup_cancel: Arc::new(AtomicBool::new(false)),
            train_child_kill: Mutex::new(None),
            download_child_kill: Mutex::new(None),
            control_dir: Mutex::new(None),
        }
    }
}

pub fn engine_dir() -> PathBuf {
    // Prefer current ModelShaper (or portable) root.
    let neu = crate::settings::default_engine_dir();
    if neu.exists() {
        return neu;
    }
    // Installed builds only: fall back to legacy ModelCraft engine pointer.
    // Standalone must never use the installer profile.
    if !crate::settings::is_portable() {
        let legacy = crate::settings::legacy_engine_dir();
        if legacy.exists() {
            return legacy;
        }
    }
    neu
}

pub fn marker_path() -> PathBuf {
    engine_dir().join(".engine-ready")
}

pub fn python_path_file() -> PathBuf {
    engine_dir().join("python_path.txt")
}

pub fn engine_python() -> Option<PathBuf> {
    let p = python_path_file();
    if let Ok(s) = fs::read_to_string(&p) {
        let t = s.trim();
        if !t.is_empty() && Path::new(t).exists() {
            return Some(PathBuf::from(t));
        }
    }
    let venv_py = engine_dir().join("venv").join("Scripts").join("python.exe");
    if venv_py.exists() {
        return Some(venv_py);
    }
    None
}

/// Live health check — marker alone is not enough.
pub fn health_check() -> (bool, String) {
    // Keep embedded engine package fresh before import checks.
    let _ = crate::engine_bundle::ensure_engine_pkg();

    let Some(py) = engine_python() else {
        return (false, "Setup is not finished yet.".into());
    };
    let output = win_cmd::command(&py)
        .args([
            "-c",
            "import torch, transformers, peft, trl, modelcraft_engine; \
             print('cuda', torch.cuda.is_available()); print('ok')",
        ])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            if stdout.contains("ok") {
                let cuda = stdout.contains("cuda True");
                if cuda {
                    (true, "Ready.".into())
                } else {
                    (
                        false,
                        "The graphics card is not ready. Install current NVIDIA drivers, then run setup again.".into(),
                    )
                }
            } else {
                (false, "Setup check did not finish. Try running setup again.".into())
            }
        }
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr);
            if err.contains("modelcraft_engine") {
                (
                    false,
                    "ModelShaper's training package is not linked. Open setup and run it again.".into(),
                )
            } else {
                (false, "Setup check failed. Try running setup again.".into())
            }
        }
        Err(_) => (false, "Setup check could not run. Try running setup again.".into()),
    }
}

pub fn status(needs_driver: bool) -> EngineStatus {
    if needs_driver {
        return EngineStatus {
            installed: false,
            healthy: false,
            path: Some(engine_dir().display().to_string()),
            version: None,
            message: "An NVIDIA graphics driver is needed before ModelShaper can train."
                .into(),
            needs_setup: false,
            needs_driver: true,
        };
    }

    let dir = engine_dir();
    let has_marker = marker_path().exists();
    if !has_marker || !dir.exists() {
        return EngineStatus {
            installed: false,
            healthy: false,
            path: Some(dir.display().to_string()),
            version: None,
            message: "Setup is not finished yet.".into(),
            needs_setup: true,
            needs_driver: false,
        };
    }

    let (healthy, message) = health_check();
    let version = fs::read_to_string(marker_path())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    EngineStatus {
        installed: true,
        healthy,
        path: Some(dir.display().to_string()),
        version,
        message,
        needs_setup: !healthy,
        needs_driver: false,
    }
}

fn parse_runtime_discovery(raw: &str) -> (Vec<RuntimeCandidate>, Option<String>) {
    let mut runtimes = Vec::new();
    let mut recommended = None;
    let Ok(val) = serde_json::from_str::<serde_json::Value>(raw) else {
        return (runtimes, recommended);
    };
    recommended = val
        .get("recommended")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    if let Some(arr) = val.get("candidates").and_then(|c| c.as_array()) {
        for c in arr {
            let exe = c
                .get("executable")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            if exe.is_empty() {
                continue;
            }
            let present: Vec<String> = c
                .get("present_packages")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|p| {
                            p.get("module")
                                .and_then(|m| m.as_str())
                                .map(|s| s.to_string())
                        })
                        .collect()
                })
                .unwrap_or_default();
            let missing: Vec<String> = c
                .get("missing_packages")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|p| {
                            p.get("module")
                                .and_then(|m| m.as_str())
                                .map(|s| s.to_string())
                        })
                        .collect()
                })
                .unwrap_or_default();
            runtimes.push(RuntimeCandidate {
                executable: exe,
                version: c
                    .get("version")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string()),
                ok: c.get("ok").and_then(|x| x.as_bool()).unwrap_or(false),
                supported: c.get("supported").and_then(|x| x.as_bool()).unwrap_or(false),
                has_train_stack: c
                    .get("has_train_stack")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false),
                ready_for_training: c
                    .get("ready_for_training")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false),
                cuda_available: c
                    .get("cuda")
                    .and_then(|x| x.get("available"))
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false),
                cuda_device: c
                    .get("cuda")
                    .and_then(|x| x.get("device_name"))
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string()),
                present,
                missing,
                error: c
                    .get("error")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string()),
            });
        }
    }
    (runtimes, recommended)
}

/// Discover interpreters already on this PC (no installs).
pub fn discover_runtimes(app: &AppHandle) -> Result<serde_json::Value, String> {
    let source = resolve_bundled_source(app)?;
    let script = source.join("scripts").join("discover_runtimes.py");
    if !script.exists() {
        return Err(format!("Discovery script missing: {}", script.display()));
    }
    // Prefer any existing python only to *run the discovery script*, not to install.
    let bootstrap = find_bootstrap_python()?;
    let out = win_cmd::command(&bootstrap)
        .arg(&script)
        .output()
        .map_err(|e| format!("Could not run discovery: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "Discovery failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text
        .lines()
        .rev()
        .find(|l| l.trim().starts_with('{'))
        .unwrap_or(text.trim());
    serde_json::from_str(line).map_err(|e| format!("Discovery parse error: {e}"))
}

pub fn setup_plan(app: &AppHandle) -> SetupPlan {
    // Ensure embedded engine scripts exist before discovery runs.
    let _ = crate::engine_bundle::ensure_engine_pkg();
    let discovery_result = discover_runtimes(app);
    let discovery_error = discovery_result.as_ref().err().cloned();
    let discovery = discovery_result.ok();
    let raw = discovery
        .as_ref()
        .map(|v| v.to_string())
        .unwrap_or_else(|| "{}".into());
    let (runtimes, recommended) = parse_runtime_discovery(&raw);

    let rec = runtimes.iter().find(|r| {
        recommended
            .as_ref()
            .map(|q| q.eq_ignore_ascii_case(&r.executable))
            .unwrap_or(false)
    });

    let missing = rec
        .map(|r| r.missing.clone())
        .unwrap_or_default();
    let present = rec
        .map(|r| r.present.clone())
        .unwrap_or_default();
    let can_link = rec
        .map(|r| r.has_train_stack || r.ready_for_training)
        .unwrap_or(false)
        && missing
            .iter()
            .all(|m| m == "modelcraft_engine");

    // Components: show reuse vs missing clearly — never advertise reinstalling present stacks.
    let mut components = Vec::new();
    for name in [
        "torch",
        "transformers",
        "peft",
        "trl",
        "datasets",
        "bitsandbytes",
        "modelcraft_engine",
    ] {
        let already = present.iter().any(|p| p == name);
        let is_missing = missing.iter().any(|m| m == name);
        if !already && !is_missing && rec.is_some() {
            continue;
        }
        components.push(SetupComponent {
            id: name.into(),
            name: name.into(),
            description: if already {
                "Already on the selected interpreter — will be reused, not reinstalled.".into()
            } else if name == "modelcraft_engine" {
                "Small ModelShaper package only (links into the selected interpreter).".into()
            } else {
                "Missing from the selected interpreter — install only if you approve.".into()
            },
            size_mb: if already {
                0
            } else if name == "torch" {
                2500
            } else if name == "modelcraft_engine" {
                5
            } else {
                150
            },
            already_present: already,
        });
    }

    let estimated: u32 = components
        .iter()
        .filter(|c| !c.already_present)
        .map(|c| c.size_mb)
        .sum();

    SetupPlan {
        components,
        install_dir: engine_dir().display().to_string(),
        estimated_download_mb: estimated,
        needs_internet: estimated > 0,
        notes: vec![
            "ModelShaper will not install another Python or a second copy of stacks you already have.".into(),
            "It reuses an interpreter and packages already on this PC.".into(),
            "Only packages listed as missing may be installed, and only after you approve.".into(),
            "A pointer file is stored in ModelShaper's data folder so it knows which environment to use.".into(),
        ],
        policy: vec![
            "never_install_python".into(),
            "never_duplicate_present_packages".into(),
            "only_install_missing".into(),
            "reuse_existing".into(),
        ],
        runtimes,
        recommended_python: recommended,
        missing_on_recommended: missing,
        can_link_without_install: can_link,
        discovery_error,
    }
}

fn resolve_bundled_source(app: &AppHandle) -> Result<PathBuf, String> {
    // 1) Durable extract next to app data (standalone EXE and installed builds).
    //    Must not depend on the build machine path or a sibling resources folder.
    if let Ok(pkg) = crate::engine_bundle::ensure_engine_pkg() {
        if pkg.join("modelcraft_engine").join("__init__.py").is_file() {
            return Ok(pkg);
        }
    }

    // 2) Dev: repo engine folder next to src-tauri (cargo run / local builds).
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../engine");
    if dev.join("modelcraft_engine").exists() {
        return Ok(dev.canonicalize().unwrap_or(dev));
    }

    // 3) Tauri installer resources (when present next to the installed app).
    if let Ok(res_dir) = app.path().resource_dir() {
        let res = res_dir.join("engine");
        if res.join("modelcraft_engine").exists() || res.join("pyproject.toml").exists() {
            return Ok(res);
        }
    }

    Err(
        "Bundled engine source was not found. Try running setup again, or reinstall ModelShaper."
            .into(),
    )
}

fn find_bootstrap_python() -> Result<PathBuf, String> {
    for name in ["python", "python3", "py"] {
        let mut cmd = win_cmd::command(name);
        if name == "py" {
            cmd.args(["-3", "-c", "import sys; print(sys.executable)"]);
        } else {
            cmd.args(["-c", "import sys; print(sys.executable)"]);
        }
        if let Ok(out) = cmd.output() {
            if out.status.success() {
                let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !p.is_empty() && Path::new(&p).exists() {
                    return Ok(PathBuf::from(p));
                }
            }
        }
    }
    Err(
        "No system Python 3 was found. ModelShaper will not install one - install or fix a single Python 3.10+ yourself, then try again."
            .into(),
    )
}

/// Link / minimal install: reuses the selected existing interpreter.
/// Never installs Python. Only installs packages that are missing, and only when allow_missing_install.
pub fn start_setup(
    app: AppHandle,
    state: &EngineState,
    repair: bool,
    python: String,
    allow_missing_install: bool,
) -> Result<(), String> {
    {
        let mut running = state.setup_running.lock().map_err(|e| e.to_string())?;
        if *running {
            return Err("Setup is already running.".into());
        }
        *running = true;
    }
    state.setup_cancel.store(false, Ordering::SeqCst);

    if python.trim().is_empty() || !Path::new(&python).exists() {
        *state.setup_running.lock().map_err(|e| e.to_string())? = false;
        return Err(
            "Select an existing Python on this PC. ModelShaper will not install a new one.".into(),
        );
    }

    let source = resolve_bundled_source(&app)?;
    let install_script = source.join("scripts").join("install_engine.py");
    if !install_script.exists() {
        *state.setup_running.lock().map_err(|e| e.to_string())? = false;
        return Err(format!(
            "Installer script missing at {}",
            install_script.display()
        ));
    }

    // Run the linker with the *selected* interpreter (not a download).
    let engine = engine_dir();
    fs::create_dir_all(&engine).map_err(|e| e.to_string())?;

    let mut cmd = win_cmd::command(&python);
    cmd.arg(&install_script)
        .arg("--engine-dir")
        .arg(&engine)
        .arg("--source-dir")
        .arg(&source)
        .arg("--python")
        .arg(&python)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if repair {
        cmd.arg("--repair");
    }
    if allow_missing_install {
        cmd.arg("--allow-missing-install");
    }

    let mut child = cmd.spawn().map_err(|e| {
        let _ = state.setup_running.lock().map(|mut g| *g = false);
        format!("Could not start setup with the selected Python: {e}")
    })?;

    let cancel = state.setup_cancel.clone();
    let app2 = app.clone();

    thread::spawn(move || {
        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                if cancel.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    let _ = app2.emit(
                        "setup-progress",
                        serde_json::json!({"type":"error","message":"Setup cancelled by user."}),
                    );
                    break;
                }
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                    let _ = app2.emit("setup-progress", val);
                } else {
                    let _ = app2.emit(
                        "setup-progress",
                        serde_json::json!({"type":"log","message": line}),
                    );
                }
            }
        }
        if let Some(stderr) = child.stderr.take() {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                let _ = app2.emit(
                    "setup-progress",
                    serde_json::json!({"type":"log","message": line}),
                );
            }
        }
        let _ = child.wait();
        if let Some(st) = app2.try_state::<EngineState>() {
            mark_setup_idle(&st);
        }
        let _ = app2.emit(
            "setup-progress",
            serde_json::json!({"type":"setup_finished"}),
        );
    });

    Ok(())
}

pub fn mark_setup_idle(state: &EngineState) {
    if let Ok(mut g) = state.setup_running.lock() {
        *g = false;
    }
}

pub fn cancel_setup(state: &EngineState) -> Result<(), String> {
    state.setup_cancel.store(true, Ordering::SeqCst);
    mark_setup_idle(state);
    Ok(())
}

// ——— Training job control ———

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainRequest {
    pub model_path: String,
    pub skill_name: String,
    pub skill_description: String,
    pub materials_text: String,
    pub files: Vec<String>,
    pub export_dir: String,
    pub power_mode: String,
    /// auto | Q8_0 | Q6_K | Q5_K_M | Q4_K_M | Q3_K_M
    #[serde(default)]
    pub export_quant: Option<String>,
    #[serde(default)]
    pub vram_total_mb: Option<u64>,
    /// Optional override for training step count.
    #[serde(default)]
    pub max_steps: Option<u32>,
}

pub fn start_training(
    app: AppHandle,
    state: &EngineState,
    req: TrainRequest,
) -> Result<(), String> {
    let st = status(false);
    if !st.healthy {
        return Err(st.message);
    }
    let py = engine_python().ok_or_else(|| "Engine Python not found.".to_string())?;

    let export_dir = PathBuf::from(&req.export_dir);
    fs::create_dir_all(&export_dir).map_err(|e| e.to_string())?;
    let control_dir = export_dir.join("_control");
    fs::create_dir_all(&control_dir).map_err(|e| e.to_string())?;
    // clear flags
    let _ = fs::remove_file(control_dir.join("pause.flag"));
    let _ = fs::remove_file(control_dir.join("cancel.flag"));

    let config_path = export_dir.join("_work");
    fs::create_dir_all(&config_path).map_err(|e| e.to_string())?;
    let config_file = config_path.join("job.json");
    let vram_total = req.vram_total_mb.unwrap_or_else(|| {
        crate::hw::snapshot()
            .primary_gpu
            .map(|g| g.vram_total_mb)
            .unwrap_or(0)
    });
    let export_quant = req
        .export_quant
        .as_deref()
        .unwrap_or("auto")
        .to_string();
    let config = serde_json::json!({
        "model_path": req.model_path,
        "skill_name": req.skill_name,
        "skill_description": req.skill_description,
        "materials_text": req.materials_text,
        "files": req.files,
        "export_dir": req.export_dir,
        "power_mode": req.power_mode,
        "control_dir": control_dir.display().to_string(),
        "export_quant": export_quant,
        "vram_total_mb": vram_total,
        "max_steps": req.max_steps,
    });
    fs::write(&config_file, config.to_string()).map_err(|e| e.to_string())?;

    *state.control_dir.lock().map_err(|e| e.to_string())? = Some(control_dir.clone());

    let mut child = win_cmd::command(&py)
        .args([
            "-m",
            "modelcraft_engine.worker",
            "train",
            "--config",
            &config_file.display().to_string(),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start training worker: {e}"))?;

    #[cfg(windows)]
    {
        // Best-effort below-normal priority via PowerShell if needed — process priority
        // is also set inside the Python worker with psutil.
    }

    let pid = child.id();
    *state.train_child_kill.lock().map_err(|e| e.to_string())? = Some(pid);

    let app2 = app.clone();
    thread::spawn(move || {
        if let Some(stdout) = child.stdout.take() {
            for line in BufReader::new(stdout).lines().flatten() {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                    let _ = app2.emit("training-event", val);
                } else if !line.trim().is_empty() {
                    let _ = app2.emit(
                        "training-event",
                        serde_json::json!({"type":"log","message": line}),
                    );
                }
            }
        }
        if let Some(stderr) = child.stderr.take() {
            for line in BufReader::new(stderr).lines().flatten() {
                let _ = app2.emit(
                    "training-event",
                    serde_json::json!({"type":"log","message": line}),
                );
            }
        }
        let status = child.wait();
        let code = status.ok().and_then(|s| s.code()).unwrap_or(-1);
        let _ = app2.emit(
            "training-event",
            serde_json::json!({"type":"process_exit","code": code}),
        );
    });

    // Note: PID cleared when cancel_training runs or process exits (best-effort).
    Ok(())
}

pub fn pause_training(state: &EngineState) -> Result<(), String> {
    let guard = state.control_dir.lock().map_err(|e| e.to_string())?;
    let dir = guard
        .as_ref()
        .ok_or_else(|| "No active training control directory.".to_string())?;
    fs::write(dir.join("pause.flag"), b"1").map_err(|e| e.to_string())?;
    Ok(())
}

pub fn resume_training(state: &EngineState) -> Result<(), String> {
    let guard = state.control_dir.lock().map_err(|e| e.to_string())?;
    let dir = guard
        .as_ref()
        .ok_or_else(|| "No active training control directory.".to_string())?;
    let _ = fs::remove_file(dir.join("pause.flag"));
    Ok(())
}

/// Download a full Hugging Face model package into ModelShaper models\<repo>.
/// Uses scripts/download_model.py — resumable, retries, stall-aware, rich progress.
pub fn download_hf_model(
    app: AppHandle,
    state: &EngineState,
    repo_id: String,
) -> Result<(), String> {
    let py = engine_python().ok_or_else(|| {
        "Finish the one-time setup first, then try Download again.".to_string()
    })?;
    if repo_id.trim().is_empty() || !repo_id.contains('/') {
        return Err("That model package is not configured correctly. Pick another from the list.".into());
    }

    // Prevent overlapping downloads
    if let Ok(g) = state.download_child_kill.lock() {
        if g.is_some() {
            return Err("A download is already running.".into());
        }
    }

    let settings = crate::settings::load();
    let dest_root = crate::settings::models_dir(&settings);
    fs::create_dir_all(&dest_root).map_err(|e| e.to_string())?;
    let safe_name = repo_id.replace('/', "__");
    let dest = dest_root.join(&safe_name);
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;

    // Always overwrite the helper script (embedded) so portable builds never keep a stale copy.
    let script = install_download_script(&app)?;

    let _ = app.emit(
        "download-event",
        serde_json::json!({
            "type":"progress",
            "pct":0,
            "bytes_done":0,
            "bytes_total":0,
            "bytes_remaining":0,
            "speed_bps":0,
            "message":"Starting download..."
        }),
    );

    let mut child = win_cmd::command(&py)
        .arg("-u") // unbuffered stdout so progress arrives immediately
        .arg(&script)
        .arg("--repo")
        .arg(&repo_id)
        .arg("--dest")
        .arg(&dest)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("HF_HUB_DISABLE_XET", "1")
        .env("HF_HUB_ENABLE_HF_TRANSFER", "0")
        .env("HF_HUB_DISABLE_PROGRESS_BARS", "1")
        .env("PYTHONUNBUFFERED", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start download: {e}"))?;

    let pid = child.id();
    *state
        .download_child_kill
        .lock()
        .map_err(|e| e.to_string())? = Some(pid);

    let app2 = app.clone();
    thread::spawn(move || {
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // Drain stdout and stderr in parallel so the child never blocks on a full pipe.
        let app_out = app2.clone();
        let out_handle = thread::spawn(move || {
            if let Some(stdout) = stdout {
                for line in BufReader::new(stdout).lines().flatten() {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                        let _ = app_out.emit("download-event", val);
                    } else if !line.trim().is_empty() {
                        let _ = app_out.emit(
                            "download-event",
                            serde_json::json!({"type":"log","message": line}),
                        );
                    }
                }
            }
        });
        let err_handle = thread::spawn(move || {
            if let Some(stderr) = stderr {
                for _line in BufReader::new(stderr).lines().flatten() {
                    // Warnings only — progress is on stdout JSON.
                }
            }
        });

        let _ = out_handle.join();
        let _ = err_handle.join();

        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
        if let Some(st) = app2.try_state::<EngineState>() {
            if let Ok(mut g) = st.download_child_kill.lock() {
                *g = None;
            }
        }
        // Only emit a generic error if the process failed; the script usually emits its own.
        if code != 0 && code != 130 {
            let _ = app2.emit(
                "download-event",
                serde_json::json!({
                    "type":"error",
                    "message":"Download did not finish. Use Retry download to resume and repair missing pieces."
                }),
            );
        }
        let _ = app2.emit(
            "download-event",
            serde_json::json!({"type":"process_exit","code": code}),
        );
    });

    Ok(())
}

/// Write the current download_model.py into LocalAppData (always overwrite from embed).
fn install_download_script(_app: &AppHandle) -> Result<PathBuf, String> {
    let local_scripts = engine_dir().join("scripts");
    fs::create_dir_all(&local_scripts).map_err(|e| e.to_string())?;
    let local_copy = local_scripts.join("download_model.py");

    // Always write the version compiled into this EXE — never keep a stale LocalAppData copy.
    const EMBEDDED: &str = include_str!("../../engine/scripts/download_model.py");
    fs::write(&local_copy, EMBEDDED)
        .map_err(|e| format!("Could not install download helper: {e}"))?;

    Ok(local_copy)
}

/// Fast check without importing torch (avoids multi-second freezes on button click).
pub fn can_download() -> bool {
    engine_python().is_some() && marker_path().exists()
}

pub fn cancel_download(state: &EngineState) -> Result<(), String> {
    if let Ok(mut pid_g) = state.download_child_kill.lock() {
        if let Some(pid) = pid_g.take() {
            let _ = win_cmd::command("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output();
        }
    }
    Ok(())
}

pub fn cancel_training(state: &EngineState) -> Result<(), String> {
    let guard = state.control_dir.lock().map_err(|e| e.to_string())?;
    if let Some(dir) = guard.as_ref() {
        let _ = fs::write(dir.join("cancel.flag"), b"1");
        let _ = fs::remove_file(dir.join("pause.flag"));
    }
    // Also kill process if still running hard
    if let Ok(mut pid_g) = state.train_child_kill.lock() {
        if let Some(pid) = pid_g.take() {
            let _ = win_cmd::command("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output();
        }
    }
    Ok(())
}
