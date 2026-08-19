"""Real QLoRA / LoRA training with transformers + peft + trl + bitsandbytes."""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any, Callable

Emit = Callable[[dict[str, Any]], None]


class _PauseCancelCallback:
    """Trainer callback that honors pause/cancel flag files."""

    def __init__(self, control_dir: Path, emit: Emit, max_steps: int):
        self.control_dir = control_dir
        self.emit = emit
        self.max_steps = max_steps
        self.pause_file = control_dir / "pause.flag"
        self.cancel_file = control_dir / "cancel.flag"
        self._last_emit = 0.0

    def on_step_end(self, args, state, control, **kwargs):  # noqa: ANN001
        # Cancel
        if self.cancel_file.exists():
            self.emit({"type": "log", "message": "Cancel requested - stopping after this step."})
            control.should_training_stop = True
            return control

        # Pause: block here until resume or cancel
        while self.pause_file.exists() and not self.cancel_file.exists():
            self.emit({"type": "log", "message": "Paused - waiting to resume..."})
            time.sleep(1.0)
        if self.cancel_file.exists():
            control.should_training_stop = True
            return control

        step = int(getattr(state, "global_step", 0) or 0)
        now = time.time()
        if now - self._last_emit >= 0.5 or step >= self.max_steps:
            self._last_emit = now
            loss = None
            if state.log_history:
                loss = state.log_history[-1].get("loss")
            payload: dict[str, Any] = {
                "type": "progress",
                "step": step,
                "max_steps": self.max_steps,
                "message": f"Training step {step} of {self.max_steps}",
            }
            if loss is not None:
                payload["loss"] = loss
            if step > 0 and hasattr(state, "max_steps") and state.max_steps:
                # rough ETA not always available
                pass
            self.emit(payload)
        return control


def run_training(config: dict[str, Any], emit: Emit) -> dict[str, Any]:
    """
    config keys:
      model_path, skill_name, skill_description, materials_text, files,
      export_dir, power_mode, control_dir (optional)
    """
    from modelcraft_engine.dataset import build_examples, write_jsonl
    from modelcraft_engine.export_util import write_lmstudio_readme, write_modelfile
    from modelcraft_engine.hw import plan_training

    model_path = config["model_path"]
    skill_name = config.get("skill_name") or "custom skill"
    skill_description = config.get("skill_description") or ""
    export_dir = Path(config.get("export_dir") or Path.cwd() / "exports")
    power_mode = config.get("power_mode") or "balanced"
    files = list(config.get("files") or [])
    materials_text = config.get("materials_text") or ""
    control_dir = Path(config.get("control_dir") or (export_dir / "_control"))
    control_dir.mkdir(parents=True, exist_ok=True)

    # Clear stale flags
    for name in ("pause.flag", "cancel.flag"):
        p = control_dir / name
        if p.exists():
            p.unlink()

    material_bytes = len(materials_text.encode("utf-8", errors="ignore"))
    for fp in files:
        try:
            material_bytes += Path(fp).stat().st_size
        except OSError:
            material_bytes += 5000

    plan = plan_training(
        model_path=model_path,
        power_mode=power_mode,
        material_bytes=material_bytes,
        trainable=True,
    )
    # Optional override for tests / advanced callers
    if config.get("max_steps"):
        try:
            plan.max_steps = int(config["max_steps"])
        except (TypeError, ValueError):
            pass
    emit({"type": "plan", **plan.__dict__})
    if plan.hard_blocks and not config.get("force"):
        emit({"type": "error", "code": "PLAN_BLOCKED", "message": plan.hard_blocks[0]})
        return {"ok": False}

    for w in plan.soft_warnings:
        emit({"type": "log", "message": f"Warning: {w}"})

    work = export_dir / "_work"
    work.mkdir(parents=True, exist_ok=True)
    examples = build_examples(skill_name, skill_description, materials_text, files)
    if len(examples) < 2:
        emit(
            {
                "type": "error",
                "code": "NO_DATA",
                "message": "Not enough training material was produced from your text and documents.",
            }
        )
        return {"ok": False}

    data_path = work / "train.jsonl"
    n = write_jsonl(examples, data_path)
    emit({"type": "dataset", "examples": n, "path": str(data_path)})

    try:
        import torch
        from datasets import load_dataset
        from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
        from transformers import (
            AutoModelForCausalLM,
            AutoTokenizer,
            BitsAndBytesConfig,
            TrainerCallback,
        )
        from trl import SFTConfig, SFTTrainer
    except Exception as e:
        emit(
            {
                "type": "error",
                "code": "IMPORT_FAIL",
                "message": (
                    f"Training libraries are missing or broken ({e}). "
                    "Open Settings and run Repair engine."
                ),
            }
        )
        return {"ok": False}

    if not torch.cuda.is_available():
        emit(
            {
                "type": "error",
                "code": "NO_CUDA",
                "message": "PyTorch cannot see a CUDA GPU. Install/update the NVIDIA driver and repair the engine.",
            }
        )
        return {"ok": False}

    # Lower process priority on Windows so the desktop stays usable.
    try:
        import psutil

        p = psutil.Process(os.getpid())
        if hasattr(psutil, "BELOW_NORMAL_PRIORITY_CLASS"):
            p.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
        else:
            p.nice(10)
    except Exception:
        pass

    emit(
        {
            "type": "progress",
            "step": 0,
            "max_steps": plan.max_steps,
            "message": "Loading model into GPU memory...",
        }
    )

    use_4bit = plan.load_mode == "qlora_4bit"
    tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    # Gradient checkpointing: TRL's prepare_peft_model owns kbit prep + LoRA wrap.
    # Do NOT get_peft_model before SFTTrainer — TRL re-runs prepare_model_for_kbit_training
    # on PeftModel which freezes ALL params (including LoRA) and leaves grad_norm=0 forever.
    use_grad_ckpt = True

    if use_4bit:
        bnb = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch.bfloat16
            if torch.cuda.is_bf16_supported()
            else torch.float16,
        )
        model = AutoModelForCausalLM.from_pretrained(
            model_path,
            quantization_config=bnb,
            device_map="auto",
            trust_remote_code=True,
        )
    else:
        model = AutoModelForCausalLM.from_pretrained(
            model_path,
            torch_dtype=torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16,
            device_map="auto",
            trust_remote_code=True,
        )

    # Prefer auto targets when PEFT supports it; fall back to common projection names.
    lora_kwargs: dict[str, Any] = dict(
        r=plan.lora_rank,
        lora_alpha=max(plan.lora_rank, 8),
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
    )
    try:
        lora_config = LoraConfig(target_modules="all-linear", **lora_kwargs)
    except (TypeError, ValueError):
        lora_config = LoraConfig(
            target_modules=[
                "q_proj",
                "k_proj",
                "v_proj",
                "o_proj",
                "gate_proj",
                "up_proj",
                "down_proj",
            ],
            **lora_kwargs,
        )

    ds = load_dataset("json", data_files=str(data_path), split="train")

    def formatting(example: dict[str, Any]) -> str:
        instr = example.get("instruction", "")
        inp = example.get("input", "")
        out = example.get("output", "")
        if inp:
            return f"### Instruction:\n{instr}\n\n### Input:\n{inp}\n\n### Response:\n{out}"
        return f"### Instruction:\n{instr}\n\n### Response:\n{out}"

    class FlagCallback(TrainerCallback):
        def __init__(self) -> None:
            self.inner = _PauseCancelCallback(control_dir, emit, plan.max_steps)
            self._zero_grad_streak = 0

        def on_step_end(self, args, state, control, **kwargs):  # noqa: ANN001
            # Fail fast if gradients never flow (wastes the whole run otherwise).
            try:
                if state.log_history:
                    last = state.log_history[-1]
                    gn = last.get("grad_norm", None)
                    if gn is not None:
                        if float(gn) == 0.0:
                            self._zero_grad_streak += 1
                        else:
                            self._zero_grad_streak = 0
                        if self._zero_grad_streak >= 5:
                            self.inner.emit(
                                {
                                    "type": "error",
                                    "code": "ZERO_GRAD",
                                    "message": (
                                        "Training stopped: gradient norm stayed at 0 for several steps, "
                                        "so the model was not learning. Stop training and start again. "
                                        "If this keeps happening, run Repair engine in Settings."
                                    ),
                                }
                            )
                            control.should_training_stop = True
                            return control
            except Exception:
                pass
            return self.inner.on_step_end(args, state, control, **kwargs)

    def map_row(ex: dict[str, Any]) -> dict[str, str]:
        return {"text": formatting(ex)}

    ds = ds.map(map_row)

    sft_kwargs: dict[str, Any] = dict(
        output_dir=str(work / "checkpoints"),
        max_steps=plan.max_steps,
        per_device_train_batch_size=plan.batch_size,
        gradient_accumulation_steps=plan.grad_accum,
        learning_rate=2e-4,
        logging_steps=1,
        save_steps=max(plan.max_steps // 4, 1),
        save_total_limit=2,
        bf16=torch.cuda.is_bf16_supported(),
        fp16=not torch.cuda.is_bf16_supported(),
        optim="adamw_torch",
        warmup_ratio=0.05,
        lr_scheduler_type="cosine",
        report_to=[],
        dataset_text_field="text",
        packing=False,
        gradient_checkpointing=use_grad_ckpt,
        dataloader_num_workers=0,
        remove_unused_columns=False,
    )
    # Prefer non-reentrant checkpointing when the installed transformers supports it.
    try:
        sft_kwargs["gradient_checkpointing_kwargs"] = {"use_reentrant": False}
    except Exception:
        pass

    # TRL versions differ on this field name
    try:
        sft_args = SFTConfig(**sft_kwargs, max_length=plan.max_seq_length)
    except TypeError:
        sft_kwargs.pop("gradient_checkpointing_kwargs", None)
        try:
            sft_args = SFTConfig(**sft_kwargs, max_seq_length=plan.max_seq_length)
        except TypeError:
            try:
                sft_args = SFTConfig(**sft_kwargs)
            except TypeError:
                sft_kwargs.pop("remove_unused_columns", None)
                sft_args = SFTConfig(**sft_kwargs)

    def _restore_lora_grads(m: Any) -> int:
        """Re-enable LoRA requires_grad if something froze adapters after wrap."""
        n = 0
        for name, param in m.named_parameters():
            # PEFT adapter weights use lora_A / lora_B (and variants) in the name.
            if "lora_" in name or "lora_A" in name or "lora_B" in name:
                if not param.requires_grad:
                    param.requires_grad = True
                if param.requires_grad:
                    n += 1
        return n

    def _count_trainable(m: Any) -> tuple[int, int]:
        trainable_n = sum(p.numel() for p in m.parameters() if p.requires_grad)
        total_n = sum(p.numel() for p in m.parameters())
        return trainable_n, total_n

    trainer = None
    last_err: Exception | None = None
    # Preferred: let TRL wrap with peft_config (kbit prep, then LoRA). That order keeps
    # adapters trainable. Manual wrap-before-trainer freezes LoRA under TRL 0.22+.
    ctor_attempts: list[dict[str, Any]] = [
        {"processing_class": tokenizer, "peft_config": lora_config},
        {"tokenizer": tokenizer, "peft_config": lora_config},
    ]
    for extra in ctor_attempts:
        try:
            trainer = SFTTrainer(
                model=model,
                train_dataset=ds,
                args=sft_args,
                callbacks=[FlagCallback()],
                **extra,
            )
            break
        except TypeError as e:
            last_err = e
            continue

    if trainer is None:
        # Older TRL without peft_config: wrap ourselves, then unfreeze LoRA after init.
        emit({"type": "log", "message": "Using fallback LoRA attach (older TRL API)..."})
        if use_4bit:
            try:
                model = prepare_model_for_kbit_training(
                    model, use_gradient_checkpointing=use_grad_ckpt
                )
            except TypeError:
                model = prepare_model_for_kbit_training(model)
        model = get_peft_model(model, lora_config)
        for extra in (
            {"processing_class": tokenizer},
            {"tokenizer": tokenizer},
        ):
            try:
                trainer = SFTTrainer(
                    model=model,
                    train_dataset=ds,
                    args=sft_args,
                    callbacks=[FlagCallback()],
                    **extra,
                )
                break
            except TypeError as e:
                last_err = e
                continue

    if trainer is None:
        raise RuntimeError(f"Could not create trainer: {last_err}")

    model = trainer.model
    # Safety net: TRL prepare_peft_model(peft_config=None) freezes LoRA on already-wrapped models.
    _restore_lora_grads(model)
    if hasattr(model, "enable_input_require_grads"):
        try:
            model.enable_input_require_grads()
        except Exception:
            pass

    trainable, total_params = _count_trainable(model)
    emit(
        {
            "type": "log",
            "message": (
                f"Trainable parameters: {trainable:,} of {total_params:,} "
                f"({100.0 * trainable / max(total_params, 1):.4f}%)"
            ),
        }
    )
    if trainable <= 0:
        emit(
            {
                "type": "error",
                "code": "NO_TRAINABLE_PARAMS",
                "message": (
                    "No trainable parameters were found. LoRA did not attach correctly "
                    "to this model, so training cannot update weights."
                ),
            }
        )
        return {"ok": False}

    try:
        if hasattr(model, "print_trainable_parameters"):
            model.print_trainable_parameters()
    except Exception:
        pass

    # Final safety: model must be in train mode
    model.train()
    train_out = trainer.train()

    if (control_dir / "cancel.flag").exists():
        emit({"type": "error", "code": "CANCELLED", "message": "Training was cancelled."})
        return {"ok": False, "cancelled": True}

    # Detect zero-grad abort from FlagCallback (log_history all zeros)
    try:
        hist = getattr(getattr(trainer, "state", None), "log_history", None) or []
        recent = [h.get("grad_norm") for h in hist[-8:] if isinstance(h, dict) and "grad_norm" in h]
        if recent and all(float(g) == 0.0 for g in recent):
            emit(
                {
                    "type": "error",
                    "code": "ZERO_GRAD",
                    "message": (
                        "Training finished without learning: gradient norm stayed at 0. "
                        "Try training again, or run Repair engine in Settings."
                    ),
                }
            )
            return {"ok": False}
    except Exception:
        pass
    _ = train_out

    emit(
        {
            "type": "progress",
            "step": plan.max_steps,
            "max_steps": plan.max_steps,
            "message": "Saving adapter and exports...",
        }
    )

    export_dir.mkdir(parents=True, exist_ok=True)
    lora_dir = export_dir / "lora"
    model.save_pretrained(str(lora_dir))
    tokenizer.save_pretrained(str(lora_dir))
    emit({"type": "log", "message": f"Saved adapter to {lora_dir}"})

    # Proper full-precision merge for GGUF / LM Studio (4-bit merge is not GGUF-friendly).
    merged_dir = export_dir / "merged"
    try:
        emit({"type": "log", "message": "Building full export copy..."})
        # Free training weights first when possible
        del model
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        from peft import PeftModel

        base = AutoModelForCausalLM.from_pretrained(
            model_path,
            torch_dtype=torch.float16,
            device_map="cpu",
            trust_remote_code=True,
        )
        peft_model = PeftModel.from_pretrained(base, str(lora_dir))
        merged = peft_model.merge_and_unload()
        merged.save_pretrained(str(merged_dir), safe_serialization=True)
        tokenizer.save_pretrained(str(merged_dir))
        del peft_model, merged, base
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        emit({"type": "log", "message": f"Full export saved to {merged_dir}"})
    except Exception as e:
        merged_dir = None
        emit({"type": "log", "message": f"Full export skipped: {e}"})

    gguf_path = None
    try:
        if merged_dir is not None:
            gguf_path = _export_gguf(
                merged_dir,
                export_dir,
                emit,
                model_path=model_path,
                vram_total_mb=float(config.get("vram_total_mb") or 0),
                export_quant=str(config.get("export_quant") or "auto"),
            )
    except Exception as e:
        emit({"type": "log", "message": f"LM Studio file export failed: {e}"})

    gguf_name = Path(gguf_path).name if gguf_path else "model.gguf"
    modelfile = write_modelfile(export_dir, gguf_name, skill_description, skill_name)
    write_lmstudio_readme(export_dir, gguf_name)

    # Ollama-friendly note when only LoRA exists
    (export_dir / "README-OLLAMA.txt").write_text(
        f"""ModelShaper Ollama export
=======================

If a GGUF file is present in this folder:
  ollama create {skill_name.replace(' ', '-').lower() or 'modelcraft-skill'} -f Modelfile
  ollama run {skill_name.replace(' ', '-').lower() or 'modelcraft-skill'}

If only a LoRA adapter was produced, load the same base model in your tool and attach the adapter from:
  {lora_dir}
""",
        encoding="utf-8",
    )

    result = {
        "ok": True,
        "exports": {
            "lora": str(lora_dir),
            "merged": str(merged_dir) if merged_dir else None,
            "gguf": gguf_path,
            "modelfile": str(modelfile),
            "export_dir": str(export_dir),
        },
    }
    emit({"type": "done", **result})
    return result


def _find_llama_quantize() -> Path | None:
    """Locate llama-quantize for Q4_K_M (fits typical 8-16 GB gaming GPUs)."""
    candidates: list[Path] = []
    # Bundled next to engine tools (optional)
    here = Path(__file__).resolve().parent.parent
    candidates.append(here / "tools" / "llama-quantize.exe")
    candidates.append(here / "tools" / "llama-quantize")
    # Ollama ships a working quantizer on many Windows installs
    local = os.environ.get("LOCALAPPDATA") or ""
    pf = os.environ.get("ProgramFiles") or r"C:\Program Files"
    for base in (
        Path(local) / "Programs" / "Ollama" / "lib" / "ollama",
        Path(pf) / "Ollama" / "lib" / "ollama",
        Path(r"C:\Users") / os.environ.get("USERNAME", "") / "AppData" / "Local" / "Programs" / "Ollama" / "lib" / "ollama",
    ):
        candidates.append(base / "llama-quantize.exe")
    # PATH
    which = os.environ.get("PATH", "")
    for part in which.split(os.pathsep):
        if not part:
            continue
        candidates.append(Path(part) / "llama-quantize.exe")
        candidates.append(Path(part) / "llama-quantize")
    for p in candidates:
        try:
            if p.is_file():
                return p
        except OSError:
            continue
    return None


def _run_hidden(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    kw: dict[str, Any] = {
        "capture_output": True,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
    }
    if os.name == "nt":
        kw["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    return subprocess.run(cmd, **kw)


def _export_gguf(
    model_dir: Path,
    export_dir: Path,
    emit: Emit,
    model_path: str | None = None,
    vram_total_mb: float = 0,
    export_quant: str = "auto",
) -> str | None:
    """Export chat-ready GGUF: pick largest quant that fits ~90% of GPU VRAM.

    Full F16 often OOMs in LM Studio. We convert F16 then quantize (Q8/Q6/Q5/Q4...).
    """
    if model_dir is None or not Path(model_dir).exists():
        return None

    import sys

    from modelcraft_engine.export_util import (
        estimate_params_b,
        pick_export_quant,
        plan_chat_quants,
    )
    from modelcraft_engine.hw import probe

    if vram_total_mb <= 0:
        try:
            hw = probe()
            if hw.primary_gpu:
                vram_total_mb = float(hw.primary_gpu.vram_total_mb)
        except Exception:
            vram_total_mb = 12288.0

    params_b = estimate_params_b(model_path or model_dir)
    quant_name = pick_export_quant(params_b, vram_total_mb, export_quant)
    options = plan_chat_quants(params_b, vram_total_mb, target_frac=0.90)
    opt_note = ", ".join(
        f"{o['id']} (~{o['est_vram_mb']} MB est)" for o in options[:4]
    )
    emit(
        {
            "type": "log",
            "message": (
                f"Chat file quant plan for ~{params_b:.1f}B on {int(vram_total_mb)} MB GPU "
                f"(target ~90%): choosing {quant_name}. Fits: {opt_note or quant_name}"
            ),
        }
    )

    gguf_dir = export_dir / "gguf"
    gguf_dir.mkdir(parents=True, exist_ok=True)
    f16_file = gguf_dir / "modelshaper-f16.gguf"
    out_name = f"modelshaper-{quant_name.lower()}.gguf"
    out_file = gguf_dir / out_name

    convert_candidates = [
        Path(__file__).resolve().parent.parent / "tools" / "convert_hf_to_gguf.py",
        Path(__file__).resolve().parents[2] / "tools" / "convert_hf_to_gguf.py",
    ]
    convert = next((p for p in convert_candidates if p.exists()), None)
    if not convert:
        note = export_dir / "GGUF-NOT-CREATED.txt"
        note.write_text(
            "Automatic chat-file conversion was not available on this install.\n"
            f"Your full model folder is at: {model_dir}\n",
            encoding="utf-8",
        )
        return None

    emit({"type": "log", "message": "Building chat file (step 1 of 2)..."})
    cmd = [
        sys.executable,
        str(convert),
        str(model_dir),
        "--outfile",
        str(f16_file),
        "--outtype",
        "f16",
    ]
    proc = _run_hidden(cmd)
    if (proc.stdout or "").strip():
        emit({"type": "log", "message": (proc.stdout or "")[-1500:]})
    if proc.returncode != 0 or not f16_file.exists():
        emit({"type": "log", "message": (proc.stderr or "")[-1500:]})
        note = export_dir / "GGUF-NOT-CREATED.txt"
        note.write_text(
            "Chat file conversion failed.\n"
            f"Merged model folder: {model_dir}\n"
            f"Converter exit code: {proc.returncode}\n",
            encoding="utf-8",
        )
        return None

    quant_bin = _find_llama_quantize()
    if quant_bin is not None:
        # Try preferred quant, then step down the ladder if quantize fails.
        try_order = [quant_name]
        for name, _bpw, _ in [
            ("Q8_0", 8.5, ""),
            ("Q6_K", 6.6, ""),
            ("Q5_K_M", 5.6, ""),
            ("Q4_K_M", 4.9, ""),
            ("Q3_K_M", 3.9, ""),
        ]:
            if name not in try_order:
                try_order.append(name)

        for qid in try_order:
            candidate = gguf_dir / f"modelshaper-{qid.lower()}.gguf"
            emit(
                {
                    "type": "log",
                    "message": f"Building chat file (step 2 of 2): {qid} (higher = smarter, larger)...",
                }
            )
            qproc = _run_hidden([str(quant_bin), str(f16_file), str(candidate), qid])
            if qproc.returncode == 0 and candidate.exists() and candidate.stat().st_size > 1_000_000:
                emit(
                    {
                        "type": "log",
                        "message": f"Chat file ready: {candidate.name}",
                    }
                )
                try:
                    if f16_file.stat().st_size > 4_000_000_000:
                        f16_file.unlink(missing_ok=True)  # type: ignore[arg-type]
                except OSError:
                    pass
                return str(candidate)
            emit(
                {
                    "type": "log",
                    "message": (qproc.stderr or qproc.stdout or f"{qid} quantize failed")[-800:],
                }
            )

    warn = export_dir / "README-CHAT-FILE.txt"
    warn.write_text(
        "Chat file note\n"
        "==============\n\n"
        "ModelShaper exported a full-precision chat file (F16).\n"
        "On many 8-16 GB cards this can fail to load in LM Studio (too much GPU memory).\n"
        "Install Ollama so ModelShaper can quantize to Q8/Q6/Q5 sized for your GPU.\n"
        f"\nFile: {f16_file}\n",
        encoding="utf-8",
    )
    emit(
        {
            "type": "log",
            "message": "Chat file is full-precision (large). Install Ollama for automatic quality quant next time.",
        }
    )
    return str(f16_file)
