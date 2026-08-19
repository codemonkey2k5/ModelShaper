"""Hardware probe and adaptive training planner (machine-agnostic)."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

try:
    import psutil
except ImportError:  # pragma: no cover
    psutil = None  # type: ignore


def _subprocess_kwargs() -> dict:
    if os.name == "nt":
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)}
    return {}


@dataclass
class GpuInfo:
    index: int
    name: str
    vram_total_mb: int
    vram_used_mb: int
    vram_free_mb: int
    utilization_pct: float | None = None
    temperature_c: float | None = None


@dataclass
class HardwareSnapshot:
    gpus: list[GpuInfo] = field(default_factory=list)
    primary_gpu: GpuInfo | None = None
    ram_total_mb: int = 0
    ram_used_mb: int = 0
    ram_available_mb: int = 0
    cpu_count: int = 1
    cpu_usage_pct: float | None = None
    disk_free_mb: int | None = None
    disk_total_mb: int | None = None
    disk_path: str | None = None
    nvidia_smi_ok: bool = False
    cuda_ready: bool | None = None
    notes: list[str] = field(default_factory=list)


@dataclass
class TrainingPlan:
    power_mode: str
    load_mode: str
    max_seq_length: int
    batch_size: int
    grad_accum: int
    lora_rank: int
    max_steps: int
    estimated_vram_mb: int
    hard_blocks: list[str] = field(default_factory=list)
    soft_warnings: list[str] = field(default_factory=list)
    summary: str = ""


def _run_nvidia_smi() -> tuple[list[GpuInfo], bool]:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return [], False
    try:
        out = subprocess.check_output(
            [
                exe,
                "--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=10,
            **_subprocess_kwargs(),
        )
    except (subprocess.SubprocessError, OSError):
        return [], False

    gpus: list[GpuInfo] = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 5:
            continue

        def num(i: int) -> int:
            try:
                return int(float(parts[i].split()[0]))
            except (ValueError, IndexError):
                return 0

        def opt_float(i: int) -> float | None:
            if i >= len(parts):
                return None
            try:
                return float(parts[i].split()[0])
            except (ValueError, IndexError):
                return None

        gpus.append(
            GpuInfo(
                index=num(0),
                name=parts[1],
                vram_total_mb=num(2),
                vram_used_mb=num(3),
                vram_free_mb=num(4),
                utilization_pct=opt_float(5),
                temperature_c=opt_float(6),
            )
        )
    return gpus, True


def probe() -> HardwareSnapshot:
    gpus, smi_ok = _run_nvidia_smi()
    snap = HardwareSnapshot(gpus=gpus, primary_gpu=gpus[0] if gpus else None, nvidia_smi_ok=smi_ok)

    if psutil:
        vm = psutil.virtual_memory()
        snap.ram_total_mb = int(vm.total / (1024 * 1024))
        snap.ram_used_mb = int(vm.used / (1024 * 1024))
        snap.ram_available_mb = int(vm.available / (1024 * 1024))
        snap.cpu_count = psutil.cpu_count(logical=True) or 1
        snap.cpu_usage_pct = float(psutil.cpu_percent(interval=0.1))
        disk = psutil.disk_usage(str(Path.home().anchor or "/"))
        snap.disk_free_mb = int(disk.free / (1024 * 1024))
        snap.disk_total_mb = int(disk.total / (1024 * 1024))
        snap.disk_path = str(Path.home().anchor or "/")
    else:
        snap.notes.append("psutil not installed; limited host metrics.")

    if not smi_ok:
        snap.notes.append(
            "NVIDIA management tools were not found. Install a current NVIDIA driver to enable GPU training."
        )

    try:
        import torch  # type: ignore

        snap.cuda_ready = bool(torch.cuda.is_available())
    except Exception:
        snap.cuda_ready = None

    return snap


def guess_params_b(model_path: str) -> float:
    lower = model_path.lower()
    for key, val in [
        ("70b", 70.0),
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
        ("0.5b", 0.5),
    ]:
        if key in lower:
            return val
    return 7.0


def _fmt_mb(mb: int) -> str:
    if mb >= 1024:
        return f"{mb / 1024:.1f} GB"
    return f"{mb} MB"


def plan_training(
    model_path: str,
    power_mode: str = "balanced",
    material_bytes: int = 0,
    trainable: bool = True,
    estimated_params_b: float | None = None,
) -> TrainingPlan:
    """Build a plan from *this machine's* free resources."""
    hw = probe()
    hard: list[str] = []
    soft: list[str] = []

    free_vram = hw.primary_gpu.vram_free_mb if hw.primary_gpu else 0
    total_vram = hw.primary_gpu.vram_total_mb if hw.primary_gpu else 0

    if not hw.primary_gpu:
        hard.append(
            "No NVIDIA GPU was detected. Training requires an NVIDIA GPU with a current driver."
        )
    if not trainable:
        hard.append(
            "The selected model format cannot be trained directly. Choose a Hugging Face base model folder."
        )

    params_b = estimated_params_b if estimated_params_b is not None else guess_params_b(model_path)
    base_need = int(params_b * 1000 * 0.65 + 1500)

    mode = (power_mode or "balanced").lower()
    if mode == "gentle":
        seq, batch, accum, rank, steps = 1024, 1, 8, 8, 80
        load_mode = "qlora_4bit"
        est = base_need
    elif mode == "faster":
        seq = 4096 if free_vram >= 20000 else 2048
        batch = 2 if free_vram >= 16000 else 1
        accum, rank, steps = 4, 32, 150
        load_mode = "lora_16bit" if free_vram >= 22000 else "qlora_4bit"
        est = int(base_need * 1.25)
    else:
        mode = "balanced"
        seq, batch, accum, rank, steps = 2048, 1, 4, 16, 100
        load_mode = "qlora_4bit"
        est = int(base_need * 1.05)

    # Cap context further on very small free VRAM
    if free_vram and free_vram < 8000:
        seq = min(seq, 1024)
        batch = 1
        load_mode = "qlora_4bit"

    reserve = max(int(total_vram * 0.12), 1024)
    if free_vram > 0 and est + reserve > free_vram:
        if free_vram < 3500:
            hard.append(
                f"Only {_fmt_mb(free_vram)} of GPU memory is free. "
                "Close other GPU apps (e.g. LM Studio with a model loaded), wait a few seconds, then recheck."
            )
        else:
            soft.append(
                f"Free GPU memory is a bit tight ({_fmt_mb(free_vram)} free; plan estimates ~{_fmt_mb(est)}). "
                "You can still start, or free more memory first."
            )

    if hw.ram_available_mb and hw.ram_available_mb < 4096:
        soft.append("System memory is low. Close large applications before training.")

    if material_bytes < 1500:
        soft.append("Very little training material was provided. Results may be weak.")

    if hw.disk_free_mb is not None:
        if hw.disk_free_mb < 15_000:
            hard.append(
                "Less than about 15 GB free disk space remains. Free space before training and export."
            )
        elif hw.disk_free_mb < 40_000:
            soft.append("Disk space is getting low. Exports and checkpoints need room.")

    summary = (
        f"Plan for ~{params_b:.1f}B-class model using {load_mode} on "
        f"{_fmt_mb(free_vram)} free GPU memory ({_fmt_mb(total_vram)} total). Mode: {mode}."
    )

    return TrainingPlan(
        power_mode=mode,
        load_mode=load_mode,
        max_seq_length=seq,
        batch_size=batch,
        grad_accum=accum,
        lora_rank=rank,
        max_steps=steps,
        estimated_vram_mb=est,
        hard_blocks=hard,
        soft_warnings=soft,
        summary=summary,
    )


def to_jsonable(obj: Any) -> Any:
    if hasattr(obj, "__dataclass_fields__"):
        return asdict(obj)
    return obj


PARAM_RE = re.compile(r"(\d+(?:\.\d+)?)b", re.I)
