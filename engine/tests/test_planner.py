"""Table-driven free-VRAM scenarios — planner must adapt, not assume one GPU."""

from modelcraft_engine import hw


def test_guess_params():
    assert hw.guess_params_b(r"C:\models\llama-3-8b-instruct") == 8.0
    assert hw.guess_params_b(r"D:\weights\qwen2.5-14b") == 14.0


def test_plan_has_required_fields(monkeypatch):
    fake = hw.HardwareSnapshot(
        gpus=[
            hw.GpuInfo(
                index=0,
                name="Test GPU",
                vram_total_mb=8192,
                vram_used_mb=1024,
                vram_free_mb=7168,
            )
        ],
        primary_gpu=hw.GpuInfo(
            index=0,
            name="Test GPU",
            vram_total_mb=8192,
            vram_used_mb=1024,
            vram_free_mb=7168,
        ),
        ram_total_mb=16384,
        ram_used_mb=8000,
        ram_available_mb=8384,
        cpu_count=8,
        disk_free_mb=100_000,
        disk_total_mb=500_000,
        nvidia_smi_ok=True,
    )
    monkeypatch.setattr(hw, "probe", lambda: fake)
    plan = hw.plan_training(r"C:\m\model-7b", power_mode="balanced", material_bytes=50_000)
    assert plan.batch_size >= 1
    assert plan.load_mode in {"qlora_4bit", "lora_16bit"}
    assert plan.power_mode == "balanced"


def test_no_gpu_blocks(monkeypatch):
    fake = hw.HardwareSnapshot(
        gpus=[],
        primary_gpu=None,
        ram_total_mb=16384,
        ram_available_mb=8000,
        cpu_count=4,
        disk_free_mb=100_000,
        nvidia_smi_ok=False,
    )
    monkeypatch.setattr(hw, "probe", lambda: fake)
    plan = hw.plan_training(r"C:\m\model-7b", power_mode="balanced", material_bytes=50_000)
    assert plan.hard_blocks
    assert any("GPU" in b for b in plan.hard_blocks)


def test_low_vram_gentle_shorter_context(monkeypatch):
    fake = hw.HardwareSnapshot(
        gpus=[
            hw.GpuInfo(0, "Small", 6144, 500, 5644),
        ],
        primary_gpu=hw.GpuInfo(0, "Small", 6144, 500, 5644),
        ram_total_mb=16384,
        ram_available_mb=10000,
        cpu_count=8,
        disk_free_mb=80_000,
        nvidia_smi_ok=True,
    )
    monkeypatch.setattr(hw, "probe", lambda: fake)
    plan = hw.plan_training(r"C:\m\model-7b", power_mode="gentle", material_bytes=20_000)
    assert plan.max_seq_length <= 1024
    assert plan.batch_size == 1
