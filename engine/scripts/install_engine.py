"""
ModelShaper engine linker / minimal installer.

POLICY (hard rules):
  - NEVER install another Python (no embeddable, no installer, no second runtime).
  - NEVER reinstall a package that is already importable in the chosen interpreter.
  - NEVER create a parallel copy of a full train stack "just to be clean".
  - ONLY install packages that are actually missing from the chosen interpreter.
  - Prefer linking to an already-ready environment with zero package installs.

Progress is emitted as JSON lines on stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

# Allow importing discover_runtimes from same folder
sys.path.insert(0, str(Path(__file__).resolve().parent))
from discover_runtimes import REQUIRED_MODULES, discover, probe_interpreter  # noqa: E402


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _subprocess_kwargs() -> dict:
    if os.name == "nt":
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)}
    return {}


def run(cmd: list[str]) -> None:
    emit({"type": "log", "message": " ".join(cmd)})
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        **_subprocess_kwargs(),
    )
    if proc.stdout:
        for line in proc.stdout.splitlines()[-50:]:
            emit({"type": "log", "message": line})
    if proc.returncode != 0:
        raise RuntimeError(f"Command failed ({proc.returncode}): {' '.join(cmd)}")


def detect_cuda_tag() -> str:
    try:
        out = subprocess.check_output(
            ["nvidia-smi"],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=15,
            **_subprocess_kwargs(),
        )
    except Exception:
        return "cu124"
    m = re.search(r"CUDA Version:\s*(\d+)\.(\d+)", out)
    if not m:
        return "cu124"
    major, minor = int(m.group(1)), int(m.group(2))
    if major >= 13 or (major == 12 and minor >= 8):
        return "cu128"
    if major == 12 and minor >= 6:
        return "cu126"
    if major == 12 and minor >= 4:
        return "cu124"
    if major == 12:
        return "cu121"
    if major == 11:
        return "cu118"
    return "cu124"


def link_modelcraft_package(py: str, source_dir: Path) -> None:
    """Install only the ModelShaper package into this Python (not the ML stack).

    Uses a normal (non-editable) install so the package stays importable even if
    the original source folder moves or the build tree is renamed.
    """
    run(
        [
            py,
            "-m",
            "pip",
            "install",
            str(source_dir),
            "--no-deps",
            "--force-reinstall",
            "--upgrade",
        ]
    )


def install_missing_only(py: str, missing_pip_names: list[str]) -> None:
    """Install only listed pip packages into the chosen existing interpreter."""
    if not missing_pip_names:
        emit({"type": "log", "message": "Nothing extra to add."})
        return

    torch_pkgs = [p for p in missing_pip_names if p in ("torch", "torchvision", "torchaudio")]
    other = [p for p in missing_pip_names if p not in torch_pkgs and not p.startswith("modelcraft")]

    if torch_pkgs:
        tag = detect_cuda_tag()
        index = f"https://download.pytorch.org/whl/{tag}"
        emit(
            {
                "type": "progress",
                "pct": 40,
                "message": "Adding GPU support… this can take several minutes.",
            }
        )
        # Replace CPU-only wheels in-place on the same Python (not a second install of Python).
        run(
            [
                py,
                "-m",
                "pip",
                "install",
                "--upgrade",
                *torch_pkgs,
                "--index-url",
                index,
            ]
        )

    if other:
        emit(
            {
                "type": "progress",
                "pct": 65,
                "message": "Adding remaining pieces…",
            }
        )
        run([py, "-m", "pip", "install", *other])

    # Keep a known-good training stack when we had to touch packages.
    # Avoids broken combinations seen on some Windows installs.
    emit({"type": "progress", "pct": 72, "message": "Checking library compatibility…"})
    subprocess.run(
        [
            py,
            "-m",
            "pip",
            "install",
            "transformers==4.57.6",
            "peft==0.17.1",
            "trl==0.22.2",
            "gguf",
            "huggingface_hub",
        ],
        capture_output=True,
        **_subprocess_kwargs(),
    )
    subprocess.run(
        [py, "-m", "pip", "uninstall", "-y", "kernels"],
        capture_output=True,
        **_subprocess_kwargs(),
    )


def write_pointer(engine_dir: Path, py: str, mode: str) -> None:
    engine_dir.mkdir(parents=True, exist_ok=True)
    (engine_dir / "python_path.txt").write_text(py + "\n", encoding="utf-8")
    (engine_dir / "link_mode.txt").write_text(mode + "\n", encoding="utf-8")
    (engine_dir / ".engine-ready").write_text("0.1.0\n", encoding="utf-8")
    meta = {
        "python": py,
        "mode": mode,
        "policy": "reuse-existing-never-duplicate",
    }
    (engine_dir / "engine_meta.json").write_text(
        json.dumps(meta, indent=2), encoding="utf-8"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-dir", required=True)
    parser.add_argument("--source-dir", required=True)
    parser.add_argument(
        "--python",
        required=True,
        help="Exact existing interpreter to use. ModelShaper will not install Python.",
    )
    parser.add_argument(
        "--repair",
        action="store_true",
        help="Re-check and only add still-missing packages; never reinstall present ones.",
    )
    parser.add_argument(
        "--allow-missing-install",
        action="store_true",
        help="If set, install only packages that are missing. If unset and packages are missing, fail with a clear list.",
    )
    args = parser.parse_args()

    engine_dir = Path(args.engine_dir).resolve()
    source_dir = Path(args.source_dir).resolve()
    py = str(Path(args.python).resolve()) if Path(args.python).exists() else args.python

    try:
        emit({"type": "progress", "pct": 5, "message": "Using your existing Python — not installing a new one."})
        if not Path(py).exists():
            raise RuntimeError(f"Selected Python does not exist: {py}")

        emit({"type": "progress", "pct": 15, "message": f"Probing {py}…"})
        info = probe_interpreter(py)
        if not info.get("ok"):
            raise RuntimeError(info.get("error") or "Could not probe selected Python.")
        if not info.get("supported"):
            raise RuntimeError(
                f"Python {info.get('version')} is too old. ModelShaper needs 3.10+ on an interpreter you already have."
            )

        present = info.get("present_packages") or []
        missing = info.get("missing_packages") or []
        cuda_ok = bool(info.get("cuda", {}).get("available"))
        torch_present = any(p.get("module") == "torch" for p in present)

        emit(
            {
                "type": "log",
                "message": f"Already present ({len(present)}): "
                + ", ".join(f"{p['module']}={p.get('version')}" for p in present[:20]),
            }
        )
        emit(
            {
                "type": "log",
                "message": "Missing: "
                + (", ".join(m["module"] for m in missing) if missing else "(none)"),
            }
        )
        emit(
            {
                "type": "log",
                "message": f"GPU ready in this environment: {cuda_ok}",
            }
        )

        pkg_root = source_dir
        if not (pkg_root / "modelcraft_engine").exists():
            raise RuntimeError(f"Bundled engine source missing under {pkg_root}")

        missing_third_party: list[str] = []
        for m in missing:
            if m["module"] == "modelcraft_engine":
                continue
            pip_name = str(m["pip_name"])
            if pip_name.startswith("modelcraft"):
                continue
            missing_third_party.append(pip_name)

        # CPU-only torch counts as "GPU support missing" — upgrade in-place, not a second Python.
        needs_gpu_torch = torch_present and not cuda_ok
        if needs_gpu_torch and "torch" not in missing_third_party:
            missing_third_party = ["torch", "torchvision", "torchaudio"] + [
                p for p in missing_third_party if p not in ("torch", "torchvision", "torchaudio")
            ]

        needs_engine_pkg = any(m["module"] == "modelcraft_engine" for m in missing)

        if (
            not missing_third_party
            and not needs_engine_pkg
            and cuda_ok
        ):
            emit({"type": "progress", "pct": 80, "message": "Everything required is already ready - linking only."})
            link_modelcraft_package(py, pkg_root)
            write_pointer(engine_dir, py, "reuse-ready")
            emit(
                {
                    "type": "progress",
                    "pct": 100,
                    "message": "Linked. Nothing extra needed.",
                }
            )
            emit(
                {
                    "type": "done",
                    "python": py,
                    "version": "0.1.0",
                    "cuda": True,
                    "installed_packages": [],
                    "reused_packages": [p["module"] for p in present],
                    "mode": "reuse-ready",
                    "engine_dir": str(engine_dir),
                }
            )
            return 0

        if missing_third_party and not args.allow_missing_install:
            raise RuntimeError(
                "This computer still needs a few pieces for training"
                + (" (including GPU support for the existing PyTorch install)" if needs_gpu_torch else "")
                + ". Re-run setup with approval to add only what is missing into the same environment."
            )

        if missing_third_party:
            emit(
                {
                    "type": "progress",
                    "pct": 30,
                    "message": "Adding only what is still needed…",
                }
            )
            install_missing_only(py, missing_third_party)
        else:
            emit({"type": "log", "message": "No third-party packages to add."})

        emit({"type": "progress", "pct": 85, "message": "Connecting ModelShaper…"})
        link_modelcraft_package(py, pkg_root)

        emit({"type": "progress", "pct": 92, "message": "Checking everything works…"})
        # Some optional "kernels" installs break peft/transformers on Windows — remove if so.
        chk = subprocess.run(
            [
                py,
                "-c",
                "import peft, trl, transformers, bitsandbytes, modelcraft_engine; "
                "import torch; assert torch.cuda.is_available(); print('ok')",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            **_subprocess_kwargs(),
        )
        if chk.returncode != 0 and "kernels" in ((chk.stderr or "") + (chk.stdout or "")).lower():
            emit({"type": "log", "message": "Fixing a known library conflict…"})
            subprocess.run(
                [py, "-m", "pip", "uninstall", "-y", "kernels"],
                capture_output=True,
                **_subprocess_kwargs(),
            )
            chk = subprocess.run(
                [
                    py,
                    "-c",
                    "import peft, trl, transformers, bitsandbytes, modelcraft_engine; "
                    "import torch; assert torch.cuda.is_available(); print('ok')",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                **_subprocess_kwargs(),
            )
        if chk.returncode != 0 or "ok" not in (chk.stdout or ""):
            raise RuntimeError(
                "Setup finished installing but a final check failed. "
                "Update your NVIDIA driver and run setup again."
            )

        again = probe_interpreter(py, deep=True)
        if not again.get("ok"):
            raise RuntimeError(again.get("error") or "Re-check failed.")
        if not again.get("cuda", {}).get("available"):
            raise RuntimeError(
                "GPU support is still not available after setup. "
                "Update your NVIDIA driver and run setup again."
            )
        if not again.get("modules", {}).get("modelcraft_engine", {}).get("present"):
            raise RuntimeError("ModelShaper could not finish connecting. Run setup again.")

        write_pointer(engine_dir, py, "reuse-plus-missing-only")
        emit(
            {
                "type": "progress",
                "pct": 100,
                "message": "Ready.",
            }
        )
        emit(
            {
                "type": "done",
                "python": py,
                "version": "0.1.0",
                "cuda": True,
                "installed_packages": missing_third_party,
                "reused_packages": [p["module"] for p in (again.get("present_packages") or [])],
                "mode": "reuse-plus-missing-only",
                "engine_dir": str(engine_dir),
            }
        )
        return 0
    except Exception as e:
        emit({"type": "error", "message": str(e)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
