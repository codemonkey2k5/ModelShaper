import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  EngineStatus,
  HardwareSnapshot,
  ModelScanResult,
  PowerMode,
  SetupPlan,
  TrainingPlan,
} from "./types";

const isTauri = () =>
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

export async function getHardwareSnapshot(): Promise<HardwareSnapshot> {
  if (!isTauri()) {
    throw new Error("ModelShaper must run as the desktop app (ModelShaper.exe), not in a plain browser.");
  }
  return invoke<HardwareSnapshot>("get_hardware_snapshot");
}

export async function getEngineStatus(): Promise<EngineStatus> {
  if (!isTauri()) {
    throw new Error("ModelShaper must run as the desktop app (ModelShaper.exe), not in a plain browser.");
  }
  return invoke<EngineStatus>("get_engine_status");
}

export async function getSetupPlan(): Promise<SetupPlan> {
  if (!isTauri()) {
    throw new Error("ModelShaper must run as the desktop app (ModelShaper.exe), not in a plain browser.");
  }
  return invoke<SetupPlan>("get_setup_plan");
}

export async function startEngineSetup(opts: {
  python: string;
  repair?: boolean;
  allowMissingInstall?: boolean;
}): Promise<void> {
  if (!isTauri()) throw new Error("Desktop app required.");
  return invoke("start_engine_setup", {
    repair: opts.repair ?? false,
    python: opts.python,
    allowMissingInstall: opts.allowMissingInstall ?? false,
  });
}

export async function cancelEngineSetup(): Promise<void> {
  if (!isTauri()) return;
  return invoke("cancel_engine_setup");
}

export async function markSetupIdle(): Promise<void> {
  if (!isTauri()) return;
  return invoke("mark_setup_idle");
}

export async function onSetupProgress(
  handler: (payload: Record<string, unknown>) => void,
): Promise<UnlistenFn> {
  return listen<Record<string, unknown>>("setup-progress", (e) => handler(e.payload));
}

export async function onTrainingEvent(
  handler: (payload: Record<string, unknown>) => void,
): Promise<UnlistenFn> {
  return listen<Record<string, unknown>>("training-event", (e) => handler(e.payload));
}

export async function scanModel(path: string): Promise<ModelScanResult> {
  if (!isTauri()) throw new Error("Desktop app required.");
  return invoke<ModelScanResult>("scan_model", { path });
}

export async function planTraining(args: {
  modelPath: string;
  powerMode: PowerMode;
  materialBytes: number;
  skillName: string;
}): Promise<TrainingPlan> {
  if (!isTauri()) throw new Error("Desktop app required.");
  return invoke<TrainingPlan>("plan_training", {
    modelPath: args.modelPath,
    powerMode: args.powerMode,
    materialBytes: args.materialBytes,
    skillName: args.skillName,
  });
}

export async function startTraining(request: {
  modelPath: string;
  skillName: string;
  skillDescription: string;
  materialsText: string;
  files: string[];
  exportDir: string;
  powerMode: PowerMode;
  exportQuant?: string;
  vramTotalMb?: number;
  maxSteps?: number;
}): Promise<void> {
  if (!isTauri()) throw new Error("Desktop app required.");
  return invoke("start_training", { request });
}

export async function pauseTraining(): Promise<void> {
  if (!isTauri()) throw new Error("Desktop app required.");
  return invoke("pause_training");
}

export async function resumeTraining(): Promise<void> {
  if (!isTauri()) throw new Error("Desktop app required.");
  return invoke("resume_training");
}

export async function cancelTraining(): Promise<void> {
  if (!isTauri()) throw new Error("Desktop app required.");
  return invoke("cancel_training");
}

export async function downloadHfModel(repoId: string): Promise<void> {
  if (!isTauri()) throw new Error("Desktop app required.");
  return invoke("download_hf_model", { repoId });
}

export async function cancelDownload(): Promise<void> {
  if (!isTauri()) throw new Error("Desktop app required.");
  return invoke("cancel_download");
}

/** Fast readiness check (no heavy GPU import). */
export async function canDownload(): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("can_download");
}

export async function onDownloadEvent(
  handler: (payload: Record<string, unknown>) => void,
): Promise<UnlistenFn> {
  return listen<Record<string, unknown>>("download-event", (e) => handler(e.payload));
}

export async function pickModelFolder(): Promise<string | null> {
  if (!isTauri()) throw new Error("Desktop app required.");
  const folder = await open({
    directory: true,
    multiple: false,
    title: "Choose the model folder",
  });
  return typeof folder === "string" ? folder : null;
}

/** Single chat-ready file many people already have. */
export async function pickModelFile(): Promise<string | null> {
  if (!isTauri()) throw new Error("Desktop app required.");
  const file = await open({
    multiple: false,
    title: "Choose a model file",
    filters: [{ name: "Model files", extensions: ["gguf"] }],
  });
  return typeof file === "string" ? file : null;
}

/** @deprecated use pickModelFolder / pickModelFile */
export async function pickModelPath(): Promise<string | null> {
  return pickModelFolder();
}

export async function pickDocuments(): Promise<string[]> {
  if (!isTauri()) throw new Error("Desktop app required.");
  const files = await open({
    multiple: true,
    title: "Add documents",
    filters: [
      {
        name: "Documents",
        extensions: ["txt", "md", "pdf", "docx", "csv", "json", "jsonl"],
      },
    ],
  });
  if (!files) return [];
  return Array.isArray(files) ? files : [files];
}

export async function pickExportDir(): Promise<string | null> {
  if (!isTauri()) throw new Error("Desktop app required.");
  const dir = await open({
    directory: true,
    multiple: false,
    title: "Choose export folder",
  });
  return typeof dir === "string" ? dir : null;
}

export async function openPath(path: string): Promise<void> {
  if (!isTauri()) throw new Error("Desktop app required.");
  // Prefer native host command (always allowed when registered).
  try {
    await invoke("open_folder", { path });
    return;
  } catch {
    /* fall through to plugin */
  }
  const { openPath: openFsPath } = await import("@tauri-apps/plugin-opener");
  await openFsPath(path);
}

export interface LocalPackage {
  path: string;
  folder_name: string;
  hf_repo: string | null;
  size_bytes: number | null;
  trainable: boolean;
  complete: boolean;
}

export async function listDownloadedModels(): Promise<LocalPackage[]> {
  if (!isTauri()) return [];
  return invoke<LocalPackage[]>("list_downloaded_models");
}

export async function deleteDownloadedModel(path: string): Promise<void> {
  if (!isTauri()) throw new Error("Desktop app required.");
  return invoke("delete_downloaded_model", { path });
}

export interface MaterialPreset {
  id: string;
  name: string;
  skill_name: string;
  skill_description: string;
  materials_text: string;
  material_files: { path: string; name: string; size_bytes: number }[];
  updated_at: number;
}

export async function listMaterialPresets(): Promise<MaterialPreset[]> {
  if (!isTauri()) return [];
  return invoke<MaterialPreset[]>("list_material_presets");
}

export async function saveMaterialPreset(
  preset: MaterialPreset,
): Promise<MaterialPreset> {
  if (!isTauri()) throw new Error("Desktop app required.");
  return invoke<MaterialPreset>("save_material_preset", { preset });
}

export async function deleteMaterialPreset(id: string): Promise<void> {
  if (!isTauri()) throw new Error("Desktop app required.");
  return invoke("delete_material_preset", { id });
}

export interface AppSettings {
  minimize_to_tray: boolean;
  dark_mode: boolean;
  models_dir: string | null;
  export_dir: string | null;
  presets_dir: string | null;
  update_manifest_url: string | null;
}

export async function getAppSettings(): Promise<AppSettings> {
  if (!isTauri()) {
    return {
      minimize_to_tray: true,
      dark_mode: false,
      models_dir: null,
      export_dir: null,
      presets_dir: null,
      update_manifest_url: null,
    };
  }
  return invoke<AppSettings>("get_app_settings");
}

export async function fetchUrlText(url: string): Promise<string> {
  if (!isTauri()) throw new Error("Desktop app required.");
  return invoke<string>("fetch_url_text", { url });
}

export async function getAppVersion(): Promise<string> {
  if (!isTauri()) {
    const { APP_VERSION } = await import("./version");
    return APP_VERSION;
  }
  return invoke<string>("get_app_version");
}

export async function peekStartView(): Promise<string | null> {
  try {
    return await invoke<string | null>("peek_start_view");
  } catch {
    return null;
  }
}

export interface UpdateInfo {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  url: string | null;
  notes: string | null;
}

export async function checkForUpdate(manifestUrl?: string | null): Promise<UpdateInfo> {
  if (!isTauri()) {
    const { APP_VERSION } = await import("./version");
    return {
      current_version: APP_VERSION,
      latest_version: APP_VERSION,
      update_available: false,
      url: null,
      notes: null,
    };
  }
  return invoke<UpdateInfo>("check_for_update", {
    manifestUrl: manifestUrl ?? null,
  });
}

export async function saveAppSettings(settings: AppSettings): Promise<AppSettings> {
  if (!isTauri()) throw new Error("Desktop app required.");
  return invoke<AppSettings>("save_app_settings", { settings });
}

export async function getDefaultPaths(): Promise<{
  models_dir: string;
  presets_dir: string;
  engine_dir: string;
  app_data: string;
}> {
  if (!isTauri()) {
    return { models_dir: "", presets_dir: "", engine_dir: "", app_data: "" };
  }
  return invoke("get_default_paths");
}

export async function setTrayTooltip(text: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("set_tray_tooltip", { text });
  } catch {
    /* tray optional */
  }
}

export async function showMainWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("show_main_window");
  } catch {
    /* ignore */
  }
}

export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatMb(mb: number | null | undefined): string {
  if (mb == null) return "-";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

export function pct(used: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

export function meterLevel(p: number): "ok" | "warn" | "crit" {
  if (p >= 90) return "crit";
  if (p >= 75) return "warn";
  return "ok";
}
