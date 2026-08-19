//! Engine Python package embedded in the EXE and extracted next to app data.
//!
//! Standalone ModelShaper.exe must not depend on the build tree or a sibling
//! `resources` folder. Setup/discovery always use this durable copy under
//! `{app_data}/engine/pkg`.

use std::fs;
use std::path::{Path, PathBuf};

const BUNDLE_ID: &str = concat!("modelshaper-engine-", env!("CARGO_PKG_VERSION"));

struct EmbeddedFile {
    rel: &'static str,
    bytes: &'static str,
}

fn embedded_files() -> &'static [EmbeddedFile] {
    &[
        EmbeddedFile {
            rel: "pyproject.toml",
            bytes: include_str!("../../engine/pyproject.toml"),
        },
        EmbeddedFile {
            rel: "README.md",
            bytes: include_str!("../../engine/README.md"),
        },
        EmbeddedFile {
            rel: "modelcraft_engine/__init__.py",
            bytes: include_str!("../../engine/modelcraft_engine/__init__.py"),
        },
        EmbeddedFile {
            rel: "modelcraft_engine/dataset.py",
            bytes: include_str!("../../engine/modelcraft_engine/dataset.py"),
        },
        EmbeddedFile {
            rel: "modelcraft_engine/export_util.py",
            bytes: include_str!("../../engine/modelcraft_engine/export_util.py"),
        },
        EmbeddedFile {
            rel: "modelcraft_engine/hw.py",
            bytes: include_str!("../../engine/modelcraft_engine/hw.py"),
        },
        EmbeddedFile {
            rel: "modelcraft_engine/train.py",
            bytes: include_str!("../../engine/modelcraft_engine/train.py"),
        },
        EmbeddedFile {
            rel: "modelcraft_engine/worker.py",
            bytes: include_str!("../../engine/modelcraft_engine/worker.py"),
        },
        EmbeddedFile {
            rel: "scripts/discover_runtimes.py",
            bytes: include_str!("../../engine/scripts/discover_runtimes.py"),
        },
        EmbeddedFile {
            rel: "scripts/download_model.py",
            bytes: include_str!("../../engine/scripts/download_model.py"),
        },
        EmbeddedFile {
            rel: "scripts/install_engine.py",
            bytes: include_str!("../../engine/scripts/install_engine.py"),
        },
        EmbeddedFile {
            rel: "tools/convert_hf_to_gguf.py",
            bytes: include_str!("../../engine/tools/convert_hf_to_gguf.py"),
        },
    ]
}

fn pkg_root() -> PathBuf {
    crate::settings::app_data_root().join("engine").join("pkg")
}

fn looks_complete(root: &Path) -> bool {
    root.join("modelcraft_engine").join("__init__.py").is_file()
        && root.join("scripts").join("discover_runtimes.py").is_file()
        && root.join("scripts").join("install_engine.py").is_file()
        && root.join("pyproject.toml").is_file()
}

/// Extract (or refresh) the embedded engine package into app data.
/// Returns the package root suitable for `pip install` / running scripts.
pub fn ensure_engine_pkg() -> Result<PathBuf, String> {
    crate::settings::ensure_data_dirs();
    let root = pkg_root();
    let stamp = root.join(".bundle_id");
    let current = fs::read_to_string(&stamp)
        .ok()
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if current == BUNDLE_ID && looks_complete(&root) {
        return Ok(root);
    }

    fs::create_dir_all(&root).map_err(|e| format!("Could not create engine package folder: {e}"))?;
    for file in embedded_files() {
        let mut dest = root.clone();
        for part in file.rel.split('/') {
            dest.push(part);
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
        }
        fs::write(&dest, file.bytes)
            .map_err(|e| format!("Could not write {}: {e}", dest.display()))?;
    }
    fs::write(&stamp, format!("{BUNDLE_ID}\n"))
        .map_err(|e| format!("Could not write engine bundle stamp: {e}"))?;
    Ok(root)
}
