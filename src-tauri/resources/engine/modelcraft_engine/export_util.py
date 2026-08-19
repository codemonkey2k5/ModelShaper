"""Export helpers for LM Studio / Ollama + chat quant planning."""

from __future__ import annotations

from pathlib import Path
from typing import Any


# Largest quality first. bpw ~ bits per weight for size/VRAM estimates.
QUANT_LADDER: list[tuple[str, float, str]] = [
    ("Q8_0", 8.5, "Best quality that usually still fits mid-size cards for 7-9B models"),
    ("Q6_K", 6.6, "Very high quality - strong pick when you have headroom"),
    ("Q5_K_M", 5.6, "High quality - good balance for 12-16 GB cards"),
    ("Q4_K_M", 4.9, "Smaller file - use only if higher quants do not fit"),
    ("Q3_K_M", 3.9, "Smallest usable - lower quality"),
]


def estimate_params_b(model_dir: Path | str | None) -> float:
    """Best-effort parameter count in billions from folder name or config."""
    if not model_dir:
        return 8.0
    p = Path(model_dir)
    name = (p.name + " " + str(p)).lower()
    for token, val in (
        ("70b", 70.0),
        ("34b", 34.0),
        ("32b", 32.0),
        ("14b", 14.0),
        ("13b", 13.0),
        ("12b", 12.0),
        ("9b", 9.0),
        ("8b", 8.0),
        ("7b", 7.0),
        ("4b", 4.0),
        ("3b", 3.0),
        ("1.7b", 1.7),
        ("1b", 1.0),
        ("0.6b", 0.6),
    ):
        if token in name:
            return val
    # config.json
    cfg = p / "config.json" if p.is_dir() else None
    if cfg and cfg.is_file():
        try:
            import json

            data = json.loads(cfg.read_text(encoding="utf-8"))
            # common fields
            for key in ("num_parameters", "n_params"):
                if key in data and data[key]:
                    return float(data[key]) / 1e9
            # derive from arch dims roughly
            layers = data.get("num_hidden_layers") or data.get("n_layer")
            hidden = data.get("hidden_size") or data.get("n_embd")
            inter = data.get("intermediate_size") or data.get("ffn_dim")
            vocab = data.get("vocab_size") or 32000
            if layers and hidden:
                h = float(hidden)
                L = float(layers)
                f = float(inter or h * 4)
                # rough transformer param count
                params = vocab * h + L * (4 * h * h + 3 * h * f) + h
                return max(0.5, params / 1e9)
        except Exception:
            pass
    # file size of safetensors / 2 (fp16)
    if p.is_dir():
        total = 0
        for f in p.rglob("*.safetensors"):
            try:
                total += f.stat().st_size
            except OSError:
                pass
        if total > 0:
            return max(0.5, total / 2.0 / 1e9)
    return 8.0


def estimate_chat_vram_mb(params_b: float, bpw: float, ctx_tokens: int = 8192) -> float:
    """Rough LM Studio GPU use: weights + KV/runtime overhead.

    Targets real-world load (user reported Q4_K_M ~75% of 16GB on 8B).
    """
    weight_mb = params_b * 1e9 * (bpw / 8.0) / (1024.0 * 1024.0)
    # Context / KV scales with model size; keep enough headroom for usable chat length.
    kv_mb = params_b * 180.0 * (ctx_tokens / 4096.0)
    runtime_mb = 700.0
    return weight_mb + kv_mb + runtime_mb


def plan_chat_quants(
    params_b: float,
    vram_total_mb: float,
    target_frac: float = 0.90,
) -> list[dict[str, Any]]:
    """Return quants that fit within target_frac of total VRAM, largest quality first."""
    if vram_total_mb <= 0:
        vram_total_mb = 12288.0
    budget = float(vram_total_mb) * float(target_frac)
    out: list[dict[str, Any]] = []
    for name, bpw, blurb in QUANT_LADDER:
        est = estimate_chat_vram_mb(params_b, bpw)
        if est <= budget:
            out.append(
                {
                    "id": name,
                    "label": name.replace("_", " "),
                    "bpw": bpw,
                    "blurb": blurb,
                    "est_vram_mb": int(est),
                    "est_file_gb": round(params_b * (bpw / 8.0), 2),
                    "fits": True,
                    "recommended": False,
                }
            )
    if not out:
        # Always offer smallest as last resort
        name, bpw, blurb = QUANT_LADDER[-1]
        est = estimate_chat_vram_mb(params_b, bpw)
        out.append(
            {
                "id": name,
                "label": name.replace("_", " "),
                "bpw": bpw,
                "blurb": blurb + " (tight on this GPU - free memory before loading)",
                "est_vram_mb": int(est),
                "est_file_gb": round(params_b * (bpw / 8.0), 2),
                "fits": False,
                "recommended": True,
            }
        )
    else:
        out[0]["recommended"] = True
        out[0]["blurb"] = (
            out[0]["blurb"]
            + f" - recommended: largest quality using about {int(target_frac * 100)}% of your GPU budget"
        )
    return out


def pick_export_quant(
    params_b: float,
    vram_total_mb: float,
    preference: str | None = None,
) -> str:
    """preference: auto | Q8_0 | Q6_K | ... ; auto = largest that fits ~90% VRAM."""
    pref = (preference or "auto").strip().upper()
    options = plan_chat_quants(params_b, vram_total_mb, target_frac=0.90)
    ids = [o["id"] for o in options]
    if pref and pref != "AUTO" and pref in {q[0] for q in QUANT_LADDER}:
        # Honor explicit choice even if tight (user opted in)
        return pref
    return ids[0] if ids else "Q5_K_M"


def write_modelfile(
    out_dir: Path,
    gguf_name: str,
    system_prompt: str,
    skill_name: str,
) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "Modelfile"
    system = system_prompt.strip() or f"You are specialized in: {skill_name}."
    # Defaults tuned for a small LoRA skill teach: steady answers, less rambling.
    body = f"""FROM ./{gguf_name}

SYSTEM \"\"\"{system}\"\"\"

PARAMETER temperature 0.65
PARAMETER top_p 0.9
PARAMETER top_k 40
PARAMETER repeat_penalty 1.08
PARAMETER num_ctx 8192
"""
    path.write_text(body, encoding="utf-8")
    return path


def write_lmstudio_readme(out_dir: Path, gguf_name: str) -> Path:
    path = out_dir / "README-LM-STUDIO.txt"
    path.write_text(
        f"""ModelShaper export for LM Studio
================================

1. Copy {gguf_name} into your LM Studio models folder (or use Import).
2. Select the model in LM Studio and start a chat.
3. ModelShaper picks a quant sized for about 90% of your GPU memory so quality
   stays high. Full-precision (f16) files are usually too large for 8-16 GB cards.

Suggested chat settings (start here, then tweak)
-----------------------------------------------
Temperature:     0.65  (try 0.4-0.5 for more factual / less creative;
                        try 0.75-0.85 if answers feel stiff)
Top P:           0.90
Top K:           40
Repeat penalty:  1.05 to 1.15 (raise a little if it loops phrases)
Context length:  4096 to 8192 if your GPU can hold it
System prompt:   Short reminder of the skill you trained (same idea as your
                 skill description in ModelShaper)

Tips
----
- Use the skill you trained for; off-topic asks fall back toward the base model.
- Prefer questions written like your materials (plain Q&A), not web-page noise.
- If the model echoes ads or site chrome, clean those from materials and train again.

This file was generated locally by ModelShaper. Nothing was uploaded.
""",
        encoding="utf-8",
    )
    return path
