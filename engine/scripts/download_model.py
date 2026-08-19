#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Robust, resumable Hugging Face full-package downloader for ModelShaper.

Emits JSON lines on stdout:
  {"type":"progress","pct":...,"bytes_done":...,"bytes_total":...,"bytes_remaining":...,
   "speed_bps":...,"eta_sec":...,"files_done":...,"files_total":...,"current_file":...,"message":...}
  {"type":"done","path":...}
  {"type":"error","message":...}
  {"type":"log","message":...}

Self-healing:
  - Skips files already present with correct size
  - Re-downloads incomplete / wrong-size files
  - Retries failed files with backoff
  - Detects stalls (no byte growth) and retries the current file
  - Prefers classic HTTPS download when XET causes hangs (env override)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path


def emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def human_bytes(n: float | int | None) -> str:
    if n is None:
        return "-"
    n = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024 or unit == "TB":
            if unit == "B":
                return f"{int(n)} {unit}"
            return f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} TB"


def human_speed(bps: float) -> str:
    return f"{human_bytes(bps)}/s"


def configure_hub_env() -> None:
    # Prefer stable HTTPS transfers; XET has been observed to stall with no file growth.
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "0")
    # Less noisy; we emit our own progress.
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")


def list_remote_files(repo: str) -> list[tuple[str, int]]:
    from huggingface_hub import HfApi

    api = HfApi()
    info = api.repo_info(repo_id=repo, repo_type="model", files_metadata=True)
    files: list[tuple[str, int]] = []
    for s in info.siblings or []:
        name = getattr(s, "rfilename", None) or ""
        if not name or name.endswith("/"):
            continue
        # Skip LFS pointer junk names if any; keep real package files
        size = getattr(s, "size", None)
        if size is None:
            size = 0
        files.append((name, int(size)))
    return files


def local_size(path: Path) -> int:
    try:
        return path.stat().st_size if path.is_file() else -1
    except OSError:
        return -1


def download_one(
    repo: str,
    filename: str,
    dest: Path,
    expected: int,
    max_attempts: int = 5,
) -> int:
    """Download one file with retries. Returns final local size."""
    from huggingface_hub import hf_hub_download

    target = dest / filename
    target.parent.mkdir(parents=True, exist_ok=True)

    # Already complete
    if expected > 0 and local_size(target) == expected:
        return expected
    if expected == 0 and target.is_file() and local_size(target) >= 0:
        return local_size(target)

    last_err: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        # Remove partial wrong-sized file before retry
        if target.is_file() and expected > 0 and local_size(target) != expected:
            try:
                target.unlink()
            except OSError:
                pass
        # Clean incomplete siblings huggingface may leave
        for pattern in (f"{filename}.incomplete", f"{filename}.lock"):
            p = dest / pattern
            if p.exists():
                try:
                    p.unlink()
                except OSError:
                    pass

        try:
            path = hf_hub_download(
                repo_id=repo,
                filename=filename,
                local_dir=str(dest),
                force_download=False,
            )
            got = local_size(Path(path))
            if expected > 0 and got != expected:
                # Size mismatch - force re-download next attempt
                try:
                    Path(path).unlink()
                except OSError:
                    pass
                raise IOError(f"Size mismatch for {filename}: got {got}, expected {expected}")
            return got if got >= 0 else 0
        except Exception as e:
            last_err = e
            wait = min(2 ** attempt, 30)
            emit(
                {
                    "type": "log",
                    "message": f"Retry {attempt}/{max_attempts} for {filename}: {e}",
                }
            )
            time.sleep(wait)

    raise RuntimeError(f"Failed to download {filename} after {max_attempts} tries: {last_err}")


def verify_package(dest: Path) -> bool:
    if not (dest / "config.json").is_file():
        return False
    if any(dest.glob("*.safetensors")):
        return True
    if any(dest.rglob("*.safetensors")):
        return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True, help="Hugging Face repo id")
    parser.add_argument("--dest", required=True, help="Local directory for package")
    parser.add_argument("--max-file-attempts", type=int, default=5)
    parser.add_argument(
        "--stall-seconds",
        type=int,
        default=120,
        help="If overall progress stalls this long, emit a warning (file retries still apply)",
    )
    args = parser.parse_args()

    configure_hub_env()
    repo = args.repo.strip()
    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)

    emit(
        {
            "type": "progress",
            "pct": 1,
            "message": "Contacting the download server...",
            "bytes_done": 0,
            "bytes_total": 0,
            "bytes_remaining": 0,
            "speed_bps": 0,
        }
    )

    try:
        emit(
            {
                "type": "progress",
                "pct": 2,
                "message": "Looking up package file list...",
                "bytes_done": 0,
                "bytes_total": 0,
                "bytes_remaining": 0,
                "speed_bps": 0,
            }
        )
        files = list_remote_files(repo)
    except Exception as e:
        msg = str(e)
        if "401" in msg or "403" in msg or "gated" in msg.lower():
            msg = (
                "This package needs free sign-in approval on the model website first. "
                "Use Show package files, accept access if asked, then try Download again."
            )
        emit({"type": "error", "message": msg})
        return 1

    if not files:
        emit({"type": "error", "message": "No files found for that package."})
        return 1

    # Prefer known package pieces first (config/tokenizer), then large weights
    def sort_key(item: tuple[str, int]) -> tuple:
        name, size = item
        if name == "config.json":
            return (0, 0)
        if name.endswith((".json", ".txt", ".jinja", ".md")):
            return (1, size)
        if name.endswith(".safetensors") or name.endswith(".bin"):
            return (2, -size)  # largest weights next among weights... actually download small first for early feedback
        return (3, size)

    # Small files first so UI shows real progress quickly; large weights after
    files_sorted = sorted(files, key=lambda x: (0 if x[1] < 5_000_000 else 1, -x[1] if x[1] >= 5_000_000 else x[1]))

    total = sum(max(0, s) for _, s in files_sorted)
    # Pre-count already complete
    already = 0
    pending: list[tuple[str, int]] = []
    for name, size in files_sorted:
        local = dest / name
        if size > 0 and local_size(local) == size:
            already += size
        elif size == 0 and local.is_file():
            already += max(0, local_size(local))
        else:
            pending.append((name, size))

    def recount_done() -> tuple[int, int]:
        """Return (bytes accounted complete, files complete)."""
        b = 0
        n = 0
        for name, size in files_sorted:
            ls = local_size(dest / name)
            if size > 0 and ls == size:
                b += size
                n += 1
            elif size == 0 and ls >= 0 and (dest / name).is_file():
                b += ls
                n += 1
            elif ls > 0 and size > 0:
                # Partial file - count partial bytes so progress moves during large transfers
                b += min(ls, size)
        return b, n

    done_bytes, files_done = recount_done()
    start = time.time()
    session_base = done_bytes
    last_emit = 0.0
    last_growth = time.time()
    last_done_snapshot = done_bytes
    files_total = len(files_sorted)

    def emit_progress(current_file: str = "", message: str | None = None) -> None:
        nonlocal last_emit, done_bytes, files_done
        done_bytes, files_done = recount_done()
        now = time.time()
        elapsed = max(now - start, 0.001)
        session = max(0, done_bytes - session_base)
        speed = session / elapsed
        remaining = max(0, total - done_bytes)
        eta = int(remaining / speed) if speed > 1 else None
        pct = (100.0 * done_bytes / total) if total > 0 else 0.0
        msg = message or (
            f"{human_bytes(done_bytes)} of {human_bytes(total)} | {human_speed(speed)} | "
            f"{human_bytes(remaining)} left"
            + (f" | ~{eta // 60}m {eta % 60}s" if eta is not None and eta < 86400 else "")
        )
        emit(
            {
                "type": "progress",
                "pct": round(min(100.0, pct), 2),
                "bytes_done": int(done_bytes),
                "bytes_total": int(total),
                "bytes_remaining": int(remaining),
                "speed_bps": float(speed),
                "eta_sec": eta,
                "files_done": files_done,
                "files_total": files_total,
                "current_file": current_file,
                "message": msg,
            }
        )
        last_emit = now

    emit_progress(
        message=f"Package has {files_total} files ({human_bytes(total)}). Resuming if possible..."
    )

    try:
        for name, size in pending:
            if done_bytes == last_done_snapshot and (time.time() - last_growth) > args.stall_seconds:
                emit(
                    {
                        "type": "log",
                        "message": f"No progress for {args.stall_seconds}s - will retry this file...",
                    }
                )
                last_growth = time.time()

            emit_progress(current_file=name, message=None)
            download_one(repo, name, dest, size, max_attempts=args.max_file_attempts)
            emit_progress(current_file=name)
            if done_bytes > last_done_snapshot:
                last_done_snapshot = done_bytes
                last_growth = time.time()

    except Exception as e:
        msg = str(e)
        if "401" in msg or "403" in msg or "gated" in msg.lower():
            msg = (
                "This package needs free sign-in approval on the model website first. "
                "Use Show package files, accept access if asked, then try Download again."
            )
        emit({"type": "error", "message": msg})
        return 1

    if not verify_package(dest):
        emit(
            {
                "type": "error",
                "message": "Download finished but the package looks incomplete. Try Download again - it will resume and repair missing pieces.",
            }
        )
        return 3

    # Reconcile final size from disk
    disk_total = 0
    for p in dest.rglob("*"):
        if p.is_file():
            try:
                disk_total += p.stat().st_size
            except OSError:
                pass

    emit(
        {
            "type": "progress",
            "pct": 100,
            "bytes_done": disk_total,
            "bytes_total": max(total, disk_total),
            "bytes_remaining": 0,
            "speed_bps": 0,
            "eta_sec": 0,
            "files_done": files_total,
            "files_total": files_total,
            "current_file": "",
            "message": f"Complete | {human_bytes(disk_total)}",
        }
    )
    emit({"type": "done", "path": str(dest.resolve())})
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        emit({"type": "error", "message": "Download was cancelled."})
        raise SystemExit(130)
