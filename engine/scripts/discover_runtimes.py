"""
Discover existing Python interpreters and which ModelShaper dependencies
they already provide. Never installs anything.

JSON lines / single JSON object on stdout when run as main.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def _subprocess_kwargs() -> dict:
    """Never flash console windows when launched from a GUI app on Windows."""
    if os.name == "nt":
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        return {"creationflags": flags}
    return {}


# Packages required for training. Only these may ever be proposed for install,
# and only when missing from the chosen interpreter.
REQUIRED_MODULES = [
    ("torch", "torch"),
    ("transformers", "transformers"),
    ("accelerate", "accelerate"),
    ("peft", "peft"),
    ("trl", "trl"),
    ("datasets", "datasets"),
    ("bitsandbytes", "bitsandbytes"),
    ("safetensors", "safetensors"),
    ("psutil", "psutil"),
    ("pypdf", "pypdf"),
    ("docx", "python-docx"),
]


def _run_py(exe: str, code: str, timeout: int = 20) -> tuple[int, str, str]:
    try:
        p = subprocess.run(
            [exe, "-c", code],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            **_subprocess_kwargs(),
        )
        return p.returncode, p.stdout or "", p.stderr or ""
    except Exception as e:
        return 1, "", str(e)


def _candidate_paths() -> list[str]:
    found: list[str] = []
    seen: set[str] = set()

    def add(p: str | None) -> None:
        if not p:
            return
        try:
            rp = str(Path(p).resolve())
        except Exception:
            rp = p
        key = rp.lower()
        if key in seen:
            return
        if not Path(rp).exists():
            return
        seen.add(key)
        found.append(rp)

    # PATH
    for name in ("python", "python3"):
        add(shutil.which(name))

    # py launcher versions
    py = shutil.which("py")
    if py:
        for ver in ("-3.13", "-3.12", "-3.11", "-3.10", "-3"):
            try:
                out = subprocess.check_output(
                    [py, ver, "-c", "import sys; print(sys.executable)"],
                    text=True,
                    stderr=subprocess.DEVNULL,
                    timeout=8,
                    **_subprocess_kwargs(),
                ).strip()
                add(out)
            except Exception:
                pass

    # Common Windows locations (read-only discovery)
    local = os.environ.get("LOCALAPPDATA", "")
    user = os.environ.get("USERPROFILE", "")
    program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
    program_files_x86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    roots = [
        Path(local) / "Programs" / "Python",
        Path(user) / "anaconda3",
        Path(user) / "miniconda3",
        Path(user) / "miniforge3",
        Path(user) / "mambaforge",
        Path(program_files) / "Python*",
        Path(r"C:\Python*"),
        Path(program_files) / "Anaconda3",
        Path(program_files_x86) / "Anaconda3",
    ]
    # Expand globs lightly
    search_dirs: list[Path] = []
    for r in roots:
        parent = r.parent
        pattern = r.name
        if "*" in pattern and parent.exists():
            search_dirs.extend(parent.glob(pattern))
        elif r.exists():
            search_dirs.append(r)

    for d in search_dirs:
        for rel in (
            "python.exe",
            "Scripts/python.exe",
            "bin/python.exe",
            "bin/python",
        ):
            add(str(d / rel))
        # conda envs
        envs = d / "envs"
        if envs.is_dir():
            for env in envs.iterdir():
                add(str(env / "python.exe"))
                add(str(env / "Scripts" / "python.exe"))

    # Already configured pointer (if any) - ModelShaper or legacy folder name
    for folder in ("ModelShaper", "ModelCraft"):
        mc = Path(local) / folder / "engine" / "python_path.txt"
        if mc.exists():
            try:
                add(mc.read_text(encoding="utf-8").strip())
            except Exception:
                pass

    return found


def probe_interpreter(exe: str, deep: bool = True) -> dict:
    """
    Probe an existing interpreter.
    Uses importlib.util.find_spec (fast) so we do not import torch on every candidate.
    Optional deep CUDA check only when torch is present and deep=True.
    """
    # Fast path: version + package presence without heavy imports
    code = r"""
import json, sys, importlib.util
info = {
  "executable": sys.executable,
  "version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
  "version_tuple": [sys.version_info.major, sys.version_info.minor, sys.version_info.micro],
  "prefix": sys.prefix,
  "base_prefix": getattr(sys, "base_prefix", sys.prefix),
  "in_venv": sys.prefix != getattr(sys, "base_prefix", sys.prefix),
}
pairs = [
    ("torch", "torch"),
    ("transformers", "transformers"),
    ("accelerate", "accelerate"),
    ("peft", "peft"),
    ("trl", "trl"),
    ("datasets", "datasets"),
    ("bitsandbytes", "bitsandbytes"),
    ("safetensors", "safetensors"),
    ("psutil", "psutil"),
    ("pypdf", "pypdf"),
    ("docx", "python-docx"),
    ("modelcraft_engine", "modelcraft-engine"),
]
mods = {}
for mod, pip_name in pairs:
    try:
        spec = importlib.util.find_spec(mod)
        if spec is None:
            mods[mod] = {"present": False, "pip_name": pip_name}
        else:
            mods[mod] = {"present": True, "version": "installed", "pip_name": pip_name}
    except Exception as e:
        mods[mod] = {"present": False, "error": str(e)[:120], "pip_name": pip_name}
info["modules"] = mods
info["cuda"] = {"available": False, "device_count": 0, "device_name": None, "checked": False}
print(json.dumps(info))
"""
    rc, out, err = _run_py(exe, code, timeout=12)
    if rc != 0 or not out.strip():
        return {
            "executable": exe,
            "ok": False,
            "error": (err or out or "probe failed")[:400],
        }
    try:
        line = [ln for ln in out.splitlines() if ln.strip()][-1]
        data = json.loads(line)
    except Exception as e:
        return {"executable": exe, "ok": False, "error": f"parse failed: {e}"}

    data["ok"] = True
    major, minor = data.get("version_tuple", [0, 0])[:2]
    data["supported"] = (major, minor) >= (3, 10)

    present = []
    missing = []
    for mod, pip_name in REQUIRED_MODULES:
        m = data.get("modules", {}).get(mod, {})
        if m.get("present"):
            present.append(
                {
                    "module": mod,
                    "pip_name": pip_name,
                    "version": m.get("version", "present"),
                }
            )
        else:
            missing.append({"module": mod, "pip_name": pip_name})

    mc = data.get("modules", {}).get("modelcraft_engine", {})
    if not mc.get("present"):
        missing.append({"module": "modelcraft_engine", "pip_name": "modelcraft-engine (bundled)"})
    else:
        present.append(
            {
                "module": "modelcraft_engine",
                "pip_name": "modelcraft-engine",
                "version": mc.get("version", "present"),
            }
        )

    data["present_packages"] = present
    data["missing_packages"] = missing

    # Deep CUDA check only when torch is present (one heavy import max per env we care about)
    if deep and data.get("modules", {}).get("torch", {}).get("present"):
        crc, cout, cerr = _run_py(
            exe,
            "import json,torch; "
            "d={'available':bool(torch.cuda.is_available()),'device_count':int(torch.cuda.device_count()) if torch.cuda.is_available() else 0,'device_name':None,'checked':True}; "
            "d['device_name']=torch.cuda.get_device_name(0) if d['available'] and d['device_count'] else None; "
            "print(json.dumps(d))",
            timeout=45,
        )
        if crc == 0 and cout.strip():
            try:
                data["cuda"] = json.loads([ln for ln in cout.splitlines() if ln.strip()][-1])
            except Exception:
                data["cuda"] = {"available": False, "checked": True, "error": "parse"}
        else:
            data["cuda"] = {
                "available": False,
                "checked": True,
                "error": (cerr or cout or "cuda probe failed")[:200],
            }

    data["ready_for_training"] = (
        data["supported"]
        and len([m for m in missing if m["module"] != "modelcraft_engine"]) == 0
        and bool(data.get("cuda", {}).get("available"))
        and bool(data.get("modules", {}).get("modelcraft_engine", {}).get("present"))
    )
    data["has_train_stack"] = (
        data["supported"]
        and all(data.get("modules", {}).get(m, {}).get("present") for m, _ in REQUIRED_MODULES)
        and bool(data.get("cuda", {}).get("available"))
    )
    return data


def discover() -> dict:
    # Cap probes so setup cannot spawn a storm of processes or hang the UI.
    paths = _candidate_paths()[:8]
    # Phase 1: fast package presence for all candidates (no torch import).
    light: list[dict] = []
    for exe in paths:
        light.append(probe_interpreter(exe, deep=False))

    # Phase 2: deep CUDA only for supported envs that already have torch (max 3).
    deep_budget = 3
    candidates = []
    for info in light:
        if (
            deep_budget > 0
            and info.get("ok")
            and info.get("supported")
            and info.get("modules", {}).get("torch", {}).get("present")
        ):
            candidates.append(probe_interpreter(info["executable"], deep=True))
            deep_budget -= 1
        else:
            candidates.append(info)

    # Prefer: ready_for_training, then has_train_stack, then most packages present
    def score(c: dict) -> tuple:
        if not c.get("ok"):
            return (-1, 0, 0, 0)
        return (
            1 if c.get("ready_for_training") else 0,
            1 if c.get("has_train_stack") else 0,
            len(c.get("present_packages") or []),
            1 if c.get("cuda", {}).get("available") else 0,
        )

    candidates_ok = [c for c in candidates if c.get("ok") and c.get("supported")]
    candidates_ok.sort(key=score, reverse=True)
    recommended = candidates_ok[0]["executable"] if candidates_ok else None

    return {
        "candidates": candidates,
        "recommended": recommended,
        "policy": {
            "never_install_python": True,
            "never_duplicate_present_packages": True,
            "only_install_missing": True,
            "reuse_existing": True,
        },
    }


if __name__ == "__main__":
    print(json.dumps(discover(), ensure_ascii=False))
