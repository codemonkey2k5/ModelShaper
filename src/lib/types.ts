export type Readiness = "ok" | "warn" | "bad" | "unknown";

export interface GpuInfo {
  index: number;
  name: string;
  vram_total_mb: number;
  vram_used_mb: number;
  vram_free_mb: number;
  utilization_pct: number | null;
  temperature_c: number | null;
}

export interface HardwareSnapshot {
  gpus: GpuInfo[];
  primary_gpu: GpuInfo | null;
  ram_total_mb: number;
  ram_used_mb: number;
  ram_available_mb: number;
  cpu_count: number;
  cpu_usage_pct: number | null;
  disk_free_mb: number | null;
  disk_total_mb: number | null;
  disk_path: string | null;
  nvidia_smi_ok: boolean;
  cuda_ready: boolean | null;
  notes: string[];
}

export interface EngineStatus {
  installed: boolean;
  healthy: boolean;
  path: string | null;
  version: string | null;
  message: string;
  needs_setup: boolean;
  needs_driver: boolean;
}

export interface SetupComponent {
  id: string;
  name: string;
  description: string;
  size_mb: number;
  already_present: boolean;
}

export interface RuntimeCandidate {
  executable: string;
  version: string | null;
  ok: boolean;
  supported: boolean;
  has_train_stack: boolean;
  ready_for_training: boolean;
  cuda_available: boolean;
  cuda_device: string | null;
  present: string[];
  missing: string[];
  error: string | null;
}

export interface SetupPlan {
  components: SetupComponent[];
  install_dir: string;
  estimated_download_mb: number;
  needs_internet: boolean;
  notes: string[];
  policy: string[];
  runtimes: RuntimeCandidate[];
  recommended_python: string | null;
  missing_on_recommended: string[];
  can_link_without_install: boolean;
  discovery_error?: string | null;
}

export type ModelFormat = "huggingface" | "gguf" | "unknown";

export interface ModelScanResult {
  path: string;
  format: ModelFormat;
  display_name: string;
  size_bytes: number | null;
  trainable: boolean;
  message: string;
  help_tip: string;
  estimated_params_b: number | null;
  suggested_search: string | null;
}

export type PowerMode = "gentle" | "balanced" | "faster";

export interface TrainingPlan {
  power_mode: PowerMode;
  load_mode: string;
  max_seq_length: number;
  batch_size: number;
  grad_accum: number;
  lora_rank: number;
  max_steps: number;
  estimated_vram_mb: number;
  hard_blocks: string[];
  soft_warnings: string[];
  summary: string;
}

export interface MaterialFile {
  path: string;
  name: string;
  size_bytes: number;
}

/** Chat export quant: auto = largest that fits ~90% GPU, or explicit Q8_0 / Q6_K / ... */
export type ExportQuant = "auto" | "Q8_0" | "Q6_K" | "Q5_K_M" | "Q4_K_M" | "Q3_K_M";

export interface WizardState {
  step: number;
  skillName: string;
  skillDescription: string;
  modelPath: string;
  modelScan: ModelScanResult | null;
  materialsText: string;
  materialFiles: MaterialFile[];
  powerMode: PowerMode;
  /** Chat file quality after training */
  exportQuant: ExportQuant;
  /**
   * How long to train (maps to step count).
   * quick ≈ less learning, standard default, thorough = more passes over your material.
   */
  trainLength: "quick" | "standard" | "thorough";
  exportDir: string;
  plan: TrainingPlan | null;
  trainingActive: boolean;
  trainingPaused: boolean;
  progressPct: number;
  progressLabel: string;
  logs: string[];
  exportPaths: { gguf?: string; lora?: string; modelfile?: string } | null;
}

export type AppView = "setup" | "wizard" | "help" | "settings";

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}

export const WIZARD_STEPS = [
  { id: "check", label: "System check" },
  { id: "model", label: "Choose model" },
  { id: "skill", label: "Describe skill" },
  { id: "materials", label: "Add materials" },
  { id: "review", label: "Review plan" },
  { id: "train", label: "Train" },
  { id: "export", label: "Export" },
] as const;
