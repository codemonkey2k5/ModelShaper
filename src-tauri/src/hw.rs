use crate::win_cmd;
use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use sysinfo::System;

#[derive(Debug, Clone, Serialize)]
pub struct GpuInfo {
    pub index: u32,
    pub name: String,
    pub vram_total_mb: u64,
    pub vram_used_mb: u64,
    pub vram_free_mb: u64,
    pub utilization_pct: Option<f32>,
    pub temperature_c: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HardwareSnapshot {
    pub gpus: Vec<GpuInfo>,
    pub primary_gpu: Option<GpuInfo>,
    pub ram_total_mb: u64,
    pub ram_used_mb: u64,
    pub ram_available_mb: u64,
    pub cpu_count: usize,
    pub cpu_usage_pct: Option<f32>,
    pub disk_free_mb: Option<u64>,
    pub disk_total_mb: Option<u64>,
    pub disk_path: Option<String>,
    pub nvidia_smi_ok: bool,
    pub cuda_ready: Option<bool>,
    pub notes: Vec<String>,
}

/// Kept alive so CPU % is measured between refreshes (sysinfo needs two samples).
static SYS: Mutex<Option<System>> = Mutex::new(None);

/// Probe host resources. Never assumes a specific GPU model or VRAM size.
pub fn snapshot() -> HardwareSnapshot {
    let mut guard = SYS.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        let mut s = System::new();
        s.refresh_memory();
        s.refresh_cpu_usage();
        // First CPU sample is meaningless; take a short second sample.
        std::thread::sleep(Duration::from_millis(200));
        s.refresh_cpu_usage();
        *guard = Some(s);
    } else if let Some(sys) = guard.as_mut() {
        sys.refresh_memory();
        sys.refresh_cpu_usage();
    }

    let sys = guard.as_ref().unwrap();
    let ram_total_mb = sys.total_memory() / (1024 * 1024);
    let ram_used_mb = sys.used_memory() / (1024 * 1024);
    let ram_available_mb = sys.available_memory() / (1024 * 1024);
    let cpu_count = sys.cpus().len().max(1);
    // Clamp silly first-read values
    let raw_cpu = sys.global_cpu_usage();
    let cpu_usage_pct = if raw_cpu.is_finite() {
        Some(raw_cpu.clamp(0.0, 100.0))
    } else {
        None
    };

    let (gpus, nvidia_smi_ok) = query_nvidia_gpus();
    let primary_gpu = gpus.first().cloned();

    let mut notes = Vec::new();
    if !nvidia_smi_ok {
        notes.push(
            "A supported NVIDIA graphics driver was not found. Training needs one.".into(),
        );
    } else if gpus.is_empty() {
        notes.push("No NVIDIA graphics card was reported.".into());
    }

    let (disk_free_mb, disk_total_mb, disk_path) = disk_for_data_dir();

    HardwareSnapshot {
        gpus,
        primary_gpu,
        ram_total_mb,
        ram_used_mb,
        ram_available_mb,
        cpu_count,
        cpu_usage_pct,
        disk_free_mb,
        disk_total_mb,
        disk_path,
        nvidia_smi_ok,
        cuda_ready: None,
        notes,
    }
}

fn query_nvidia_gpus() -> (Vec<GpuInfo>, bool) {
    // Must use CREATE_NO_WINDOW — nvidia-smi is a console app and will flash windows otherwise.
    let output = win_cmd::command("nvidia-smi")
        .args([
            "--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu",
            "--format=csv,noheader,nounits",
        ])
        .output();

    let Ok(out) = output else {
        return (Vec::new(), false);
    };
    if !out.status.success() {
        return (Vec::new(), false);
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let mut gpus = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
        if parts.len() < 5 {
            continue;
        }
        let index = parts[0].parse().unwrap_or(0);
        let name = parts[1].to_string();
        let total = parse_u64(parts[2]);
        let used = parse_u64(parts[3]);
        let free = parse_u64(parts[4]);
        let util = parts.get(5).and_then(|s| s.parse().ok());
        let temp = parts.get(6).and_then(|s| s.parse().ok());
        gpus.push(GpuInfo {
            index,
            name,
            vram_total_mb: total,
            vram_used_mb: used,
            vram_free_mb: free,
            utilization_pct: util,
            temperature_c: temp,
        });
    }
    (gpus, true)
}

fn parse_u64(s: &str) -> u64 {
    s.split_whitespace()
        .next()
        .and_then(|x| x.parse().ok())
        .unwrap_or(0)
}

fn disk_for_data_dir() -> (Option<u64>, Option<u64>, Option<String>) {
    let path = dirs::data_local_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let path_str = path.display().to_string();

    let disks = sysinfo::Disks::new_with_refreshed_list();
    let mut best: Option<(u64, u64, String)> = None;
    for disk in disks.list() {
        let mount = disk.mount_point().to_string_lossy().to_string();
        let matches = path_str
            .get(..2)
            .map(|prefix| mount.to_uppercase().starts_with(&prefix.to_uppercase()))
            .unwrap_or(false);
        let free = disk.available_space() / (1024 * 1024);
        let total = disk.total_space() / (1024 * 1024);
        if matches {
            return (Some(free), Some(total), Some(mount));
        }
        if best.as_ref().map(|(f, _, _)| free > *f).unwrap_or(true) {
            best = Some((free, total, mount));
        }
    }
    if let Some((f, t, m)) = best {
        (Some(f), Some(t), Some(m))
    } else {
        (None, None, Some(path_str))
    }
}

/// Adaptive training plan from live hardware — not tied to a fixed GPU SKU.
#[derive(Debug, Clone, Serialize)]
pub struct TrainingPlan {
    pub power_mode: String,
    pub load_mode: String,
    pub max_seq_length: u32,
    pub batch_size: u32,
    pub grad_accum: u32,
    pub lora_rank: u32,
    pub max_steps: u32,
    pub estimated_vram_mb: u64,
    pub hard_blocks: Vec<String>,
    pub soft_warnings: Vec<String>,
    pub summary: String,
}

pub fn plan_training(
    model_path: &str,
    power_mode: &str,
    material_bytes: u64,
    _skill_name: &str,
    model_trainable: bool,
    estimated_params_b: Option<f32>,
) -> TrainingPlan {
    let hw = snapshot();
    let mut hard_blocks = Vec::new();
    let mut soft_warnings = Vec::new();

    let free_vram = hw
        .primary_gpu
        .as_ref()
        .map(|g| g.vram_free_mb)
        .unwrap_or(0);
    let total_vram = hw
        .primary_gpu
        .as_ref()
        .map(|g| g.vram_total_mb)
        .unwrap_or(0);

    if hw.primary_gpu.is_none() {
        hard_blocks.push(
            "No NVIDIA graphics card was found. Teaching a model needs one.".into(),
        );
    }

    if !model_trainable {
        hard_blocks.push(
            "This model is not in a form ModelShaper can teach. Choose a full model folder (not only a single chat file).".into(),
        );
    }

    let params_b = estimated_params_b.unwrap_or_else(|| guess_params_from_path(model_path));

    let base_need = ((params_b * 1000.0) * 0.65 + 1500.0) as u64;
    let (seq, batch, accum, rank, steps, load_mode, est_vram) = match power_mode {
        "gentle" => (
            1024u32,
            1u32,
            8u32,
            8u32,
            80u32,
            "qlora_4bit",
            base_need,
        ),
        "faster" => (
            if free_vram >= 20000 { 4096 } else { 2048 },
            if free_vram >= 16000 { 2 } else { 1 },
            4,
            32,
            150,
            if free_vram >= 22000 {
                "lora_16bit"
            } else {
                "qlora_4bit"
            },
            (base_need as f64 * 1.25) as u64,
        ),
        _ => (
            2048,
            1,
            4,
            16,
            100,
            "qlora_4bit",
            (base_need as f64 * 1.05) as u64,
        ),
    };

    // Soft reserve: warn early, only hard-block when free VRAM is truly too low.
    // (Closing LM Studio after a warning should allow training once memory is free again.)
    let reserve = ((total_vram as f64) * 0.12).max(1024.0) as u64;
    if free_vram > 0 && est_vram + reserve > free_vram {
        if free_vram < 3500 {
            hard_blocks.push(format!(
                "Only {} of graphics memory is free right now. Close other heavy apps (for example LM Studio with a model loaded), wait a few seconds, then use Recheck this PC.",
                format_mb(free_vram)
            ));
        } else {
            soft_warnings.push(format!(
                "Graphics memory is a bit tight ({} free; plan wants about {}). You can still start, or free more memory first.",
                format_mb(free_vram),
                format_mb(est_vram)
            ));
        }
    }

    if hw.ram_available_mb < 4096 {
        soft_warnings.push(
            "System memory is low. Close large applications before starting.".into(),
        );
    }

    if material_bytes < 1500 {
        soft_warnings.push(
            "Very little material was added. Results may be weak.".into(),
        );
    }

    if let Some(free_disk) = hw.disk_free_mb {
        if free_disk < 15_000 {
            hard_blocks.push(
                "There is not enough free disk space (need roughly 15 GB free).".into(),
            );
        } else if free_disk < 40_000 {
            soft_warnings.push(
                "Disk space is getting low. Exports need room.".into(),
            );
        }
    }

    let summary = format!(
        "Plan for about a {:.1}B-size model. Graphics free memory: {}. Mode: {}.",
        params_b,
        format_mb(free_vram),
        power_mode
    );

    TrainingPlan {
        power_mode: power_mode.to_string(),
        load_mode: load_mode.to_string(),
        max_seq_length: seq,
        batch_size: batch,
        grad_accum: accum,
        lora_rank: rank,
        max_steps: steps,
        estimated_vram_mb: est_vram,
        hard_blocks,
        soft_warnings,
        summary,
    }
}

fn guess_params_from_path(path: &str) -> f32 {
    let lower = path.to_lowercase();
    for (k, v) in [
        ("70b", 70.0),
        ("65b", 65.0),
        ("34b", 34.0),
        ("33b", 33.0),
        ("32b", 32.0),
        ("27b", 27.0),
        ("22b", 22.0),
        ("14b", 14.0),
        ("13b", 13.0),
        ("12b", 12.0),
        ("9b", 9.0),
        ("8b", 8.0),
        ("7b", 7.0),
        ("3b", 3.0),
        ("1b", 1.0),
        ("0.5b", 0.5),
    ] {
        if lower.contains(k) {
            return v;
        }
    }
    7.0
}

fn format_mb(mb: u64) -> String {
    if mb >= 1024 {
        format!("{:.1} GB", mb as f64 / 1024.0)
    } else {
        format!("{} MB", mb)
    }
}
