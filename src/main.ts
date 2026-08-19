import type {
  AppView,
  EngineStatus,
  HardwareSnapshot,
  WizardState,
} from "./lib/types";
import { WIZARD_STEPS } from "./lib/types";
import {
  canDownload,
  cancelDownload,
  cancelEngineSetup,
  cancelTraining,
  deleteDownloadedModel,
  downloadHfModel,
  checkForUpdate,
  fetchUrlText,
  formatBytes,
  formatMb,
  getAppSettings,
  getAppVersion,
  getDefaultPaths,
  getEngineStatus,
  getHardwareSnapshot,
  getSetupPlan,
  listDownloadedModels,
  listMaterialPresets,
  markSetupIdle,
  meterLevel,
  onDownloadEvent,
  onSetupProgress,
  onTrainingEvent,
  openExternal,
  openPath,
  pct,
  pauseTraining,
  peekStartView,
  pickDocuments,
  pickExportDir,
  pickModelFile,
  pickModelFolder,
  planTraining,
  resumeTraining,
  saveAppSettings,
  saveMaterialPreset,
  scanModel,
  setTrayTooltip,
  startEngineSetup,
  startTraining,
  type AppSettings,
  type LocalPackage,
  type MaterialPreset,
  type UpdateInfo,
} from "./lib/api";
import { estimateParamsB, planChatQuants } from "./lib/quants";
import type { SetupPlan } from "./lib/types";
import {
  MODEL_CATALOG,
  SIZE_SLIDER_MAX,
  SIZE_SLIDER_MIN,
  filterCatalog,
  fitForVram,
  fitLabel,
  formatParamsB,
  type CatalogModel,
} from "./lib/catalog";
import { APP_VERSION, UPDATE_MANIFEST_URL } from "./lib/version";
import {
  acceptConfirm,
  confirmAsync,
  dismissConfirm,
  getActiveConfirm,
  setConfirmRenderer,
} from "./lib/confirm";

const root = document.getElementById("app")!;

let view: AppView = "wizard";
let hw: HardwareSnapshot | null = null;
let engineStatus: EngineStatus | null = null;
let setupBusy = false;
let setupProgress = 0;
let setupMessage = "";
let errorBanner: string | null = null;
/** Settings-only messages (never show model-page alerts on Settings). */
let settingsBanner: string | null = null;
/** Optional update notice (non-blocking). */
let updateInfo: UpdateInfo | null = null;
let selectedPython: string | null = null;
let cachedSetupPlan: SetupPlan | null = null;
/** catalog = pick uncensored package; local = folder/file already on disk */
let modelSourceTab: "catalog" | "local" = "catalog";
let selectedCatalogId: string | null = null;
/** Catalog size range (billions of parameters), dual slider */
let catalogMinB = 3;
let catalogMaxB = 14;
/** When true, only uncensored / abliterated packages */
let catalogUncensoredOnly = true;
let downloadBusy = false;
let downloadMessage = "";
let downloadPct = 0;
let downloadBytesDone = 0;
let downloadBytesTotal = 0;
let downloadBytesRemaining = 0;
let downloadSpeedBps = 0;
let downloadEtaSec: number | null = null;
let downloadFilesDone = 0;
let downloadFilesTotal = 0;
let downloadCurrentFile = "";
let downloadUnlisten: (() => void) | null = null;
/** After a failed download, show Retry on the same page */
let downloadFailed = false;
let lastDownloadModelId: string | null = null;
/** True after a successful "done" event for the current download session */
let downloadSucceeded = false;
/** Prevent double-clicks while confirm/start is in flight */
let downloadClickLock = false;
/** Packages already on disk under ModelShaper models folder */
let localPackages: LocalPackage[] = [];
let localPackagesLoaded = false;
/** Must accept before starting training */
let liabilityAccepted = false;
/** Wall-clock timing for training ETA (client-side estimate) */
let trainTiming: {
  startedAt: number;
  lastStep: number;
  maxSteps: number;
  etaLabel: string;
} | null = null;
/** Cached skill packs (name, description, materials text + docs) */
let materialPresets: MaterialPreset[] = [];
let materialPresetsLoaded = false;
/** Currently loaded/saved skill pack id (for overwrite saves) */
let activeSkillId: string | null = null;
/** User preferences (tray, theme, paths) */
let appSettings: AppSettings = {
  minimize_to_tray: true,
  dark_mode: false,
  models_dir: null,
  export_dir: null,
  presets_dir: null,
  update_manifest_url: null,
};
let materialsUrlInput = "";
let defaultPaths: {
  models_dir: string;
  presets_dir: string;
  engine_dir: string;
  app_data: string;
  portable?: boolean;
} | null = null;

function applyTheme(dark: boolean) {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}

function pushTrayStatus() {
  if (wizard.trainingActive) {
    void setTrayTooltip(`Training ${Math.round(wizard.progressPct)}%`);
  } else if (downloadBusy) {
    void setTrayTooltip(`Download ${downloadPct.toFixed(0)}%`);
  } else if (downloadSucceeded) {
    void setTrayTooltip("Download complete");
  } else if (wizard.progressLabel === "Complete" || wizard.exportPaths) {
    void setTrayTooltip("Ready");
  } else {
    void setTrayTooltip("");
  }
}

const wizard: WizardState = {
  step: 0,
  skillName: "",
  skillDescription: "",
  modelPath: "",
  modelScan: null,
  materialsText: "",
  materialFiles: [],
  powerMode: "balanced",
  exportQuant: "auto",
  trainLength: "standard",
  exportDir: "",
  plan: null,
  trainingActive: false,
  trainingPaused: false,
  progressPct: 0,
  progressLabel: "Not started",
  logs: [],
  exportPaths: null,
};

let hwTimer: number | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function render() {
  // Keep the main pane from jumping to the top on every re-render (selections, toggles).
  const prevMain = document.querySelector(".app-main") as HTMLElement | null;
  const prevSide = document.querySelector(".app-sidebar") as HTMLElement | null;
  const mainTop = prevMain?.scrollTop ?? 0;
  const sideTop = prevSide?.scrollTop ?? 0;

  root.replaceChildren();
  const confirm = getActiveConfirm();

  if (engineStatus?.needs_setup || view === "setup") {
    root.appendChild(renderSetup());
  } else {
    root.appendChild(renderShell());
  }

  if (confirm) {
    root.appendChild(renderConfirm(confirm));
  }

  const nextMain = document.querySelector(".app-main") as HTMLElement | null;
  const nextSide = document.querySelector(".app-sidebar") as HTMLElement | null;
  if (nextMain) nextMain.scrollTop = mainTop;
  if (nextSide) nextSide.scrollTop = sideTop;
}

function renderConfirm(c: NonNullable<ReturnType<typeof getActiveConfirm>>) {
  const backdrop = el("div", "modal-backdrop");
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) dismissConfirm();
  });

  const modal = el("div", "modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.appendChild(el("h2", undefined, c.title));
  modal.appendChild(el("p", undefined, c.message));

  const actions = el("div", "modal-actions");
  const cancelBtn = el("button", "btn btn-secondary", c.cancelLabel);
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", () => dismissConfirm());

  const okBtn = el(
    "button",
    c.danger ? "btn btn-danger" : "btn btn-primary",
    c.confirmLabel,
  );
  okBtn.type = "button";
  okBtn.addEventListener("click", () => acceptConfirm());

  // Safe action is default focus
  actions.appendChild(cancelBtn);
  actions.appendChild(okBtn);
  modal.appendChild(actions);
  backdrop.appendChild(modal);

  queueMicrotask(() => cancelBtn.focus());
  return backdrop;
}

function renderSetup(): HTMLElement {
  const screen = el("div", "setup-screen");
  const card = el("div", "setup-card");

  const brand = el("div", "brand");
  brand.style.marginBottom = "var(--mc-space-6)";
  brand.appendChild(el("div", "brand-mark"));
  const bt = el("div", "brand-text");
  bt.appendChild(el("div", "brand-name", "ModelShaper"));
  bt.appendChild(el("div", "brand-tag", "First-time setup"));
  brand.appendChild(bt);
  card.appendChild(brand);

  if (engineStatus?.needs_driver) {
    card.appendChild(el("h1", "page-title", "A graphics update is needed"));
    card.appendChild(
      el(
        "p",
        "page-lead",
        "ModelShaper needs an NVIDIA graphics card with up-to-date drivers. Install the free driver from NVIDIA, restart if asked, then come back and try again.",
      ),
    );
    const row = el("div", "btn-row");
    const link = el("button", "btn btn-primary", "Get NVIDIA drivers");
    link.type = "button";
    link.addEventListener("click", () =>
      openExternal("https://www.nvidia.com/Download/index.aspx"),
    );
    const recheck = el("button", "btn btn-secondary", "Try again");
    recheck.type = "button";
    recheck.addEventListener("click", () => void refreshStatus());
    row.appendChild(link);
    row.appendChild(recheck);
    card.appendChild(row);
    screen.appendChild(card);
    return screen;
  }

  if (setupBusy) {
    card.appendChild(el("h1", "page-title", "Getting ready..."));
    card.appendChild(
      el(
        "p",
        "page-lead",
        "Please leave this window open. You can keep using your computer for other things.",
      ),
    );
    const pb = el("div", "progress-block");
    const head = el("div", "progress-head");
    head.appendChild(el("span", undefined, plainSetupMessage(setupMessage)));
    head.appendChild(el("span", undefined, `${Math.round(setupProgress)}%`));
    pb.appendChild(head);
    const track = el("div", "progress-track");
    const fill = el("div", "progress-fill");
    fill.style.width = `${setupProgress}%`;
    track.appendChild(fill);
    pb.appendChild(track);
    card.appendChild(pb);

    const row = el("div", "btn-row");
    const stop = el("button", "btn btn-danger-outline", "Stop");
    stop.type = "button";
    stop.addEventListener("click", () => void onCancelSetup());
    row.appendChild(stop);
    card.appendChild(row);
    screen.appendChild(card);
    return screen;
  }

  if (engineStatus?.installed && engineStatus.healthy) {
    card.appendChild(el("h1", "page-title", "You're ready"));
    card.appendChild(
      el(
        "p",
        "page-lead",
        "ModelShaper is set up on this computer. Your files stay on your PC.",
      ),
    );
    const row = el("div", "btn-row");
    const start = el("button", "btn btn-primary", "Continue");
    start.type = "button";
    start.addEventListener("click", () => {
      view = "wizard";
      render();
    });
    row.appendChild(start);
    card.appendChild(row);
    screen.appendChild(card);
    return screen;
  }

  card.appendChild(el("h1", "page-title", "Welcome to ModelShaper"));
  card.appendChild(
    el(
      "p",
      "page-lead",
      "Before you can improve a model, ModelShaper needs a short one-time setup. We'll walk you through it.",
    ),
  );

  const listHost = el("div");
  listHost.appendChild(el("p", "muted", "Checking this computer..."));
  card.appendChild(listHost);

  const planPromise = cachedSetupPlan ? Promise.resolve(cachedSetupPlan) : getSetupPlan();
  void planPromise.then((plan) => {
    cachedSetupPlan = plan;
    listHost.replaceChildren();

    const usable = plan.runtimes.filter((r) => r.ok && r.supported);
    // Pick the best option automatically - users should not choose technical paths.
    selectedPython =
      plan.recommended_python ||
      usable.find((r) => r.has_train_stack || r.ready_for_training)?.executable ||
      usable[0]?.executable ||
      null;

    if (!usable.length || !selectedPython) {
      const detail =
        plan.discovery_error ||
        "ModelShaper could not find Python 3.10+ on this PC. Install Python from python.org (check \"Add python.exe to PATH\"), then open ModelShaper again and run setup. An NVIDIA GPU with current drivers is also required for training.";
      listHost.appendChild(
        el(
          "div",
          "alert alert-danger",
          detail,
        ),
      );
      const row = el("div", "btn-row");
      const help = el("button", "btn btn-secondary", "Open Help");
      help.type = "button";
      help.addEventListener("click", () => {
        view = "help";
        render();
      });
      row.appendChild(help);
      listHost.appendChild(row);
      return;
    }

    const selected = usable.find((r) => r.executable === selectedPython) || usable[0];
    const needsDownload =
      plan.estimated_download_mb > 0 &&
      !(selected.has_train_stack || selected.ready_for_training);

    if (needsDownload) {
      const info = el("div", "alert alert-info");
      info.innerHTML = `A download of about <strong>${formatMb(plan.estimated_download_mb)}</strong> may be needed, and an internet connection is required for this step. This usually only happens once.`;
      listHost.appendChild(info);
    } else {
      listHost.appendChild(
        el(
          "div",
          "alert alert-ok",
          "This computer looks ready. Setup should only take a moment.",
        ),
      );
    }

    listHost.appendChild(
      el(
        "p",
        "muted",
        "Your documents and models are never sent to us. Setup only prepares ModelShaper to work on this PC.",
      ),
    );

    const row = el("div", "btn-row");
    const go = el("button", "btn btn-primary", "Set up ModelShaper");
    go.type = "button";
    go.addEventListener("click", () => void onApproveSetup(false, needsDownload));

    const later = el("button", "btn btn-ghost", "Look around first");
    later.type = "button";
    later.addEventListener("click", () => {
      view = "wizard";
      if (engineStatus) engineStatus.needs_setup = true;
      render();
    });
    row.appendChild(go);
    row.appendChild(later);
    listHost.appendChild(row);
  });

  screen.appendChild(card);
  return screen;
}

/** Map technical progress text to plain language when we can. */
function plainSetupMessage(raw: string): string {
  const s = (raw || "").toLowerCase();
  if (!raw) return "Please wait...";
  if (s.includes("error") || s.includes("fail")) return raw; // keep real errors visible
  if (s.includes("probing") || s.includes("scanning") || s.includes("preparing"))
    return "Checking this computer...";
  if (s.includes("download") || s.includes("installing missing") || s.includes("installing gpu"))
    return "Downloading what is still needed...";
  if (s.includes("health") || s.includes("re-check") || s.includes("linking"))
    return "Finishing up...";
  if (s.includes("finished") || s.includes("ready") || s.includes("successfully"))
    return "Done.";
  if (s.includes("nothing new") || s.includes("already"))
    return "Almost done...";
  // Don't dump package names or paths at users
  if (raw.length > 80 || raw.includes("\\") || raw.includes("pip")) return "Working...";
  return raw;
}

let setupUnlisten: (() => void) | null = null;
let trainUnlisten: (() => void) | null = null;

async function onApproveSetup(repair = false, allowMissingInstall = false) {
  const plan = cachedSetupPlan || (await getSetupPlan());
  if (!selectedPython) {
    selectedPython =
      plan.recommended_python ||
      plan.runtimes.find((r) => r.ok && r.supported)?.executable ||
      null;
  }
  if (!selectedPython) {
    errorBanner =
      "Setup cannot continue on this computer right now. Open Help for what to try next.";
    render();
    return;
  }

  const needsNet = allowMissingInstall && plan.estimated_download_mb > 0;
  const ok = await confirmAsync({
    title: repair ? "Run setup again?" : "Start setup?",
    message: needsNet
      ? `ModelShaper will prepare itself on this computer. This may download about ${formatMb(plan.estimated_download_mb)} and can take several minutes. Continue?`
      : "ModelShaper will prepare itself on this computer. This usually only takes a moment. Continue?",
    confirmLabel: "Continue",
    cancelLabel: "Not now",
  });
  if (!ok) return;

  setupBusy = true;
  setupProgress = 0;
  setupMessage = "Please wait...";
  errorBanner = null;
  render();

  try {
    if (setupUnlisten) {
      setupUnlisten();
      setupUnlisten = null;
    }
    setupUnlisten = await onSetupProgress((payload) => {
      const t = String(payload.type || "");
      if (t === "progress") {
        setupProgress = Number(payload.pct ?? setupProgress);
        setupMessage = plainSetupMessage(String(payload.message || setupMessage));
        render();
      } else if (t === "log") {
        // Keep the progress line friendly; do not flash technical logs at the user.
        render();
      } else if (t === "error") {
        setupBusy = false;
        errorBanner = plainError(String(payload.message || "Setup could not finish."));
        void markSetupIdle();
        render();
      } else if (t === "done") {
        setupProgress = 100;
        setupMessage = "Done.";
        render();
      } else if (t === "setup_finished") {
        void (async () => {
          await markSetupIdle();
          await refreshStatus();
          setupBusy = false;
          view = "setup";
          render();
        })();
      }
    });
    await startEngineSetup({
      python: selectedPython,
      repair,
      allowMissingInstall,
    });
  } catch (e) {
    setupBusy = false;
    errorBanner = plainError(e instanceof Error ? e.message : String(e));
    void markSetupIdle();
    render();
  }
}

function plainError(msg: string): string {
  const s = msg.toLowerCase();
  if (s.includes("nvidia") || s.includes("driver") || s.includes("cuda")) {
    return "The graphics card is not ready for ModelShaper yet. Install current NVIDIA drivers, then try setup again.";
  }
  if (s.includes("python") && (s.includes("not found") || s.includes("no system"))) {
    return "Python 3.10+ was not found. Install it from python.org (add to PATH), then run setup again. See Help.";
  }
  if (s.includes("cancelled") || s.includes("cancel")) {
    return "Setup was stopped. You can start it again when you are ready.";
  }
  // Avoid dumping raw paths/package lists when we can
  if (msg.length > 220) return msg.slice(0, 200) + "...";
  return msg;
}

async function onCancelSetup() {
  const ok = await confirmAsync({
    title: "Stop setup?",
    message: "Setup will stop. You can start it again later from the welcome screen.",
    confirmLabel: "Stop setup",
    cancelLabel: "Keep going",
    danger: true,
  });
  if (!ok) return;
  setupBusy = false;
  setupProgress = 0;
  setupMessage = "";
  try {
    await cancelEngineSetup();
  } catch {
    /* ignore */
  }
  render();
}

function renderShell(): HTMLElement {
  const shell = el("div", "app-shell");
  shell.appendChild(renderHeader());
  shell.appendChild(renderSidebar());
  shell.appendChild(renderMain());
  return shell;
}

function renderHeader(): HTMLElement {
  const header = el("header", "app-header");
  const brand = el("div", "brand");
  brand.appendChild(el("div", "brand-mark"));
  const bt = el("div", "brand-text");
  bt.appendChild(el("div", "brand-name", "ModelShaper"));
  bt.appendChild(el("div", "brand-tag", "Adapt local models on your PC"));
  brand.appendChild(bt);
  header.appendChild(brand);

  const actions = el("div", "header-actions");
  const help = el("button", "btn btn-ghost", "Help");
  help.type = "button";
  help.addEventListener("click", () => {
    // Never touch training/download state - Help is read-only overlay of the shell.
    view = "help";
    errorBanner = null;
    render();
  });
  const settings = el("button", "btn btn-ghost", "Settings");
  settings.type = "button";
  settings.addEventListener("click", () => {
    view = "settings";
    // Do not carry model-page alerts into Settings.
    errorBanner = null;
    render();
  });
  actions.appendChild(help);
  actions.appendChild(settings);
  header.appendChild(actions);
  return header;
}

function renderSidebar(): HTMLElement {
  const side = el("aside", "app-sidebar");

  if (view === "wizard") {
    side.appendChild(el("div", "step-nav-label", "Workflow"));
    const list = el("ol", "step-list");
    WIZARD_STEPS.forEach((s, i) => {
      const item = el("li", "step-item");
      if (i === wizard.step) item.classList.add("is-active");
      if (i < wizard.step) item.classList.add("is-done");
      item.appendChild(el("span", "step-num", i < wizard.step ? "✓" : String(i + 1)));
      item.appendChild(el("span", undefined, s.label));
      list.appendChild(item);
    });
    side.appendChild(list);
  } else {
    const back = el("button", "btn btn-secondary", "Back to workflow");
    back.type = "button";
    back.addEventListener("click", () => {
      view = "wizard";
      render();
    });
    side.appendChild(back);
  }

  side.appendChild(renderResourcePanel());
  return side;
}

function renderResourcePanel(): HTMLElement {
  const panel = el("div", "resource-panel");
  panel.appendChild(el("h3", undefined, "This PC"));

  const list = el("div", "resource-list");
  const snap = hw;

  if (!snap) {
    list.appendChild(el("p", "muted", "Reading hardware..."));
    panel.appendChild(list);
    return panel;
  }

  const gpu = snap.primary_gpu;
  if (gpu) {
    const gPct = pct(gpu.vram_used_mb, gpu.vram_total_mb);
    list.appendChild(
      meter("GPU memory", `${formatMb(gpu.vram_used_mb)} / ${formatMb(gpu.vram_total_mb)}`, gPct),
    );
    const util =
      gpu.utilization_pct != null && Number.isFinite(gpu.utilization_pct)
        ? Math.max(0, Math.min(100, gpu.utilization_pct))
        : null;
    list.appendChild(
      meter(
        "GPU usage",
        util != null ? `${Math.round(util)}%` : "-",
        util ?? 0,
      ),
    );
  } else {
    list.appendChild(meter("GPU memory", "No NVIDIA GPU detected", 0));
    list.appendChild(meter("GPU usage", "-", 0));
  }

  const rPct = pct(snap.ram_used_mb, snap.ram_total_mb);
  list.appendChild(
    meter("System memory", `${formatMb(snap.ram_used_mb)} / ${formatMb(snap.ram_total_mb)}`, rPct),
  );

  if (snap.cpu_usage_pct != null) {
    list.appendChild(meter("CPU", `${Math.round(snap.cpu_usage_pct)}%`, snap.cpu_usage_pct));
  }

  if (snap.disk_free_mb != null) {
    list.appendChild(
      meter("Disk free", formatMb(snap.disk_free_mb), snap.disk_total_mb ? pct(snap.disk_total_mb - snap.disk_free_mb, snap.disk_total_mb) : 0),
    );
  }

  panel.appendChild(list);

  const meta = el("div", "resource-meta");
  meta.textContent = gpu
    ? `${gpu.name} · ${snap.cpu_count} logical CPUs`
    : `No NVIDIA GPU · ${snap.cpu_count} logical CPUs`;
  panel.appendChild(meta);
  return panel;
}

function meter(label: string, value: string, percent: number): HTMLElement {
  const m = el("div", "meter");
  const head = el("div", "meter-head");
  head.appendChild(el("span", "meter-label", label));
  head.appendChild(el("span", "meter-value", value));
  m.appendChild(head);
  const track = el("div", "meter-track");
  const fill = el("div", "meter-fill");
  const level = meterLevel(percent);
  if (level === "warn") fill.classList.add("is-warn");
  if (level === "crit") fill.classList.add("is-crit");
  fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  track.appendChild(fill);
  m.appendChild(track);
  return m;
}

function renderMain(): HTMLElement {
  const main = el("main", "app-main");
  const inner = el("div", "main-inner");

  // Jobs keep running when Help/Settings is open.
  if (
    (view === "help" || view === "settings") &&
    (wizard.trainingActive || downloadBusy)
  ) {
    const banner = el("div", "alert alert-info");
    banner.style.marginBottom = "var(--mc-space-4)";
    if (wizard.trainingActive) {
      banner.textContent = `Training continues in the background (${Math.round(wizard.progressPct)}%). Use Back to workflow to watch the log. Help and Settings never stop a job.`;
    } else {
      banner.textContent = `Download continues in the background (${downloadPct.toFixed(0)}%). Use Back to workflow to watch progress.`;
    }
    const back = el("button", "btn btn-secondary", "Back to workflow");
    back.type = "button";
    back.style.marginTop = "var(--mc-space-3)";
    back.addEventListener("click", () => {
      view = "wizard";
      if (wizard.trainingActive) wizard.step = 5;
      if (downloadBusy) wizard.step = 1;
      render();
    });
    banner.appendChild(document.createElement("br"));
    banner.appendChild(back);
    inner.appendChild(banner);
  }

  // Always-on update notice (not buried in Settings)
  if (updateInfo?.update_available) {
    const u = el("div", "alert alert-ok");
    u.style.marginBottom = "var(--mc-space-4)";
    u.appendChild(
      el(
        "p",
        undefined,
        `Update available: version ${updateInfo.latest_version} is ready (you have ${updateInfo.current_version}).`,
      ),
    );
    if (updateInfo.notes) {
      const n = el("p", undefined, updateInfo.notes);
      n.style.marginTop = "var(--mc-space-2)";
      u.appendChild(n);
    }
    const row = el("div", "btn-row");
    row.style.marginTop = "var(--mc-space-3)";
    if (updateInfo.url) {
      const link = el("button", "btn btn-primary", "Get the update");
      link.type = "button";
      link.addEventListener("click", () => {
        void openExternal(String(updateInfo!.url));
      });
      row.appendChild(link);
    }
    const dismiss = el("button", "btn btn-secondary", "Dismiss");
    dismiss.type = "button";
    dismiss.addEventListener("click", () => {
      updateInfo = updateInfo
        ? { ...updateInfo, update_available: false }
        : null;
      render();
    });
    row.appendChild(dismiss);
    u.appendChild(row);
    inner.appendChild(u);
  }

  if (errorBanner && view === "wizard") {
    const a = el("div", "alert alert-danger", errorBanner);
    inner.appendChild(a);
  }
  if (settingsBanner && view === "settings") {
    const a = el("div", "alert alert-danger", settingsBanner);
    inner.appendChild(a);
  }

  if (view === "help") {
    inner.appendChild(renderHelp());
  } else if (view === "settings") {
    inner.appendChild(renderSettings());
  } else {
    inner.appendChild(renderWizardStep());
  }

  main.appendChild(inner);
  return main;
}

function renderWizardStep(): HTMLElement {
  const wrap = el("div");
  switch (wizard.step) {
    case 0:
      wrap.appendChild(stepSystemCheck());
      break;
    case 1:
      wrap.appendChild(stepModel());
      break;
    case 2:
      wrap.appendChild(stepSkill());
      break;
    case 3:
      wrap.appendChild(stepMaterials());
      break;
    case 4:
      wrap.appendChild(stepReview());
      break;
    case 5:
      wrap.appendChild(stepTrain());
      break;
    case 6:
      wrap.appendChild(stepExport());
      break;
  }
  return wrap;
}

function stepSystemCheck(): HTMLElement {
  const box = el("div");
  box.appendChild(el("h1", "page-title", "System check"));
  box.appendChild(
    el(
      "p",
      "page-lead",
      "A quick look at this computer so ModelShaper can choose safe settings automatically.",
    ),
  );

  const grid = el("div", "check-grid");

  const gpu = hw?.primary_gpu;
  grid.appendChild(
    checkRow(
      gpu ? "ok" : "bad",
      "Graphics card",
      gpu
        ? `${gpu.name} · ${formatMb(gpu.vram_free_mb)} free of ${formatMb(gpu.vram_total_mb)}`
        : "No supported NVIDIA graphics card found. You can prepare files, but training needs one.",
    ),
  );

  grid.appendChild(
    checkRow(
      hw && hw.ram_total_mb >= 8192 ? "ok" : "warn",
      "Memory",
      hw
        ? `${formatMb(hw.ram_available_mb)} free of ${formatMb(hw.ram_total_mb)}`
        : "Checking...",
    ),
  );

  grid.appendChild(
    checkRow(
      engineStatus?.healthy ? "ok" : engineStatus?.needs_setup ? "warn" : "bad",
      "ModelShaper setup",
      engineStatus?.healthy
        ? "Ready"
        : engineStatus?.needs_setup
          ? "Setup still needed"
          : engineStatus?.message ?? "Checking...",
    ),
  );

  grid.appendChild(
    checkRow(
      hw?.disk_free_mb != null && hw.disk_free_mb > 20_000 ? "ok" : "warn",
      "Disk space",
      hw?.disk_free_mb != null
        ? `${formatMb(hw.disk_free_mb)} free`
        : "Checking...",
    ),
  );

  box.appendChild(grid);

  if (hw?.notes?.length) {
    const note = el("div", "alert alert-info");
    note.textContent = hw.notes.join(" ");
    box.appendChild(note);
    note.style.marginTop = "var(--mc-space-4)";
  }

  box.appendChild(
    navRow({
      next: () => {
        wizard.step = 1;
        render();
      },
      nextLabel: "Continue",
    }),
  );
  return box;
}

function checkRow(level: "ok" | "warn" | "bad", title: string, body: string) {
  const row = el("div", "check-item");
  const dot = el("div", `check-dot ${level}`);
  row.appendChild(dot);
  const text = el("div");
  text.appendChild(el("h4", undefined, title));
  text.appendChild(el("p", undefined, body));
  row.appendChild(text);
  return row;
}

function freeVramGb(): number | null {
  const g = hw?.primary_gpu;
  if (!g) return null;
  return g.vram_free_mb / 1024;
}

function stepModel(): HTMLElement {
  const box = el("div");

  // Full-screen download mode: no back/continue, only cancel (or retry after failure).
  // Stay here after success until Continue moves to the next wizard step.
  if (downloadBusy || (downloadSucceeded && wizard.modelPath && !downloadFailed)) {
    const done = downloadSucceeded && !downloadBusy;
    box.appendChild(
      el("h1", "page-title", done ? "Download complete" : "Downloading package"),
    );
    box.appendChild(
      el(
        "p",
        "page-lead",
        done
          ? "The package is saved on this PC. Continue to describe what you want the model to learn."
          : "Please wait. Help, Settings, and tray minimize do not stop the download. Use Cancel download only if you want to stop.",
      ),
    );
    box.appendChild(renderDownloadProgressPanel(!done));
    if (done) {
      const row = el("div", "btn-row");
      row.style.marginTop = "var(--mc-space-4)";
      const cont = el("button", "btn btn-primary", "Continue with this package");
      cont.type = "button";
      cont.addEventListener("click", () => {
        void finishDownloadAndAdvance();
      });
      row.appendChild(cont);
      box.appendChild(row);
    }
    return box;
  }

  // Refresh local package list in the background when entering this step.
  if (!localPackagesLoaded) {
    void refreshLocalPackages();
  }

  box.appendChild(el("h1", "page-title", "Choose a model"));
  box.appendChild(
    el(
      "p",
      "page-lead",
      "Pick a full model package with no built-in refusals. After teaching, ModelShaper writes a chat-ready file that runs on this PC in apps like LM Studio.",
    ),
  );

  const faq = el("div", "alert alert-info");
  faq.innerHTML = `
    <strong>Quick facts</strong>
    <ul style="margin:0.5rem 0 0 1.1rem;padding:0">
      <li><strong>Chat-ready single files</strong> (what most people already downloaded) are for talking. ModelShaper cannot teach those files directly.</li>
      <li><strong>Full packages</strong> are folders of files. That is what teaching needs. Uncensored / abliterated full packages already exist. They are not the stock "safe" models.</li>
      <li><strong>After teaching</strong> you get a chat-ready file sized for this PC. You do not need to build that yourself.</li>
    </ul>`;
  box.appendChild(faq);

  if (downloadFailed) {
    const fail = el("div", "alert alert-danger");
    fail.appendChild(
      el(
        "p",
        undefined,
        errorBanner ||
          "The download did not finish. You can retry - it will resume and fill in missing pieces.",
      ),
    );
    const retryRow = el("div", "btn-row");
    retryRow.style.marginTop = "var(--mc-space-3)";
    const retry = el("button", "btn btn-primary", "Retry download");
    retry.type = "button";
    retry.addEventListener("click", () => {
      const m = MODEL_CATALOG.find((x) => x.id === lastDownloadModelId);
      if (m) {
        errorBanner = null;
        downloadFailed = false;
        void startCatalogDownload(m);
      } else {
        errorBanner = "Pick a package from the list, then download again.";
        downloadFailed = false;
        render();
      }
    });
    const dismiss = el("button", "btn btn-secondary", "Dismiss");
    dismiss.type = "button";
    dismiss.addEventListener("click", () => {
      downloadFailed = false;
      errorBanner = null;
      render();
    });
    retryRow.appendChild(retry);
    retryRow.appendChild(dismiss);
    fail.appendChild(retryRow);
    box.appendChild(fail);
  }

  const tabs = el("div", "segmented");
  const tabCat = el("button", modelSourceTab === "catalog" ? "is-active" : "", "Recommended packages");
  tabCat.type = "button";
  tabCat.addEventListener("click", () => {
    modelSourceTab = "catalog";
    render();
  });
  const tabLocal = el("button", modelSourceTab === "local" ? "is-active" : "", "I already have files");
  tabLocal.type = "button";
  tabLocal.addEventListener("click", () => {
    modelSourceTab = "local";
    render();
  });
  tabs.appendChild(tabCat);
  tabs.appendChild(tabLocal);
  box.appendChild(tabs);

  if (modelSourceTab === "catalog") {
    box.appendChild(renderCatalogPicker());
  } else {
    box.appendChild(renderLocalModelPicker());
  }

  box.appendChild(
    navRow({
      back: () => {
        wizard.step = 0;
        render();
      },
      next: async () => {
        if (!wizard.modelPath.trim()) {
          errorBanner =
            modelSourceTab === "catalog"
              ? "Pick a package below and download it (or choose one you already saved)."
              : "Choose a full model folder before continuing.";
          render();
          return;
        }
        errorBanner = null;
        wizard.modelScan = await scanModel(wizard.modelPath.trim());
        if (!wizard.modelScan.trainable) {
          await showUnteachableModelPopup(
            wizard.modelScan.message,
            wizard.modelScan.help_tip,
          );
          modelSourceTab = "catalog";
          render();
          return;
        }
        wizard.step = 2;
        render();
      },
      nextLabel: "Continue",
    }),
  );
  return box;
}

function renderDownloadProgressPanel(withCancel: boolean): HTMLElement {
  const pb = el("div", "catalog-selection");
  pb.appendChild(el("h3", "card-title", "Downloading package..."));
  const block = el("div", "progress-block");
  const head = el("div", "progress-head");
  head.appendChild(el("span", undefined, downloadMessage || "Working..."));
  head.appendChild(el("span", undefined, `${downloadPct.toFixed(1)}%`));
  block.appendChild(head);
  const track = el("div", "progress-track");
  const fill = el("div", "progress-fill");
  fill.style.width = `${Math.min(100, Math.max(0, downloadPct))}%`;
  track.appendChild(fill);
  block.appendChild(track);
  pb.appendChild(block);

  const stats = el("div", "catalog-meta");
  stats.style.marginTop = "var(--mc-space-3)";
  if (downloadBytesTotal > 0) {
    stats.appendChild(
      el(
        "span",
        "badge badge-neutral",
        `${formatBytes(downloadBytesDone)} / ${formatBytes(downloadBytesTotal)}`,
      ),
    );
    stats.appendChild(
      el("span", "badge badge-neutral", `${formatBytes(downloadBytesRemaining)} left`),
    );
  } else {
    stats.appendChild(el("span", "badge badge-neutral", "Getting file list..."));
  }
  if (downloadSpeedBps > 0) {
    stats.appendChild(el("span", "badge badge-ok", `${formatBytes(downloadSpeedBps)}/s`));
  }
  if (downloadEtaSec != null && downloadEtaSec > 0 && downloadEtaSec < 86400) {
    const m = Math.floor(downloadEtaSec / 60);
    const s = downloadEtaSec % 60;
    stats.appendChild(
      el("span", "badge badge-neutral", m > 0 ? `~${m}m ${s}s left` : `~${s}s left`),
    );
  }
  if (downloadFilesTotal > 0) {
    stats.appendChild(
      el("span", "badge badge-neutral", `Files ${downloadFilesDone}/${downloadFilesTotal}`),
    );
  }
  pb.appendChild(stats);
  if (downloadCurrentFile) {
    pb.appendChild(el("p", "muted", `Current file: ${downloadCurrentFile}`));
  }

  if (withCancel) {
    const row = el("div", "btn-row");
    const cancel = el("button", "btn btn-danger-outline", "Cancel download");
    cancel.type = "button";
    cancel.addEventListener("click", () => void onCancelDownload());
    row.appendChild(cancel);
    pb.appendChild(row);
  }
  return pb;
}

async function onCancelDownload() {
  const ok = await confirmAsync({
    title: "Cancel download?",
    message: "The download will stop. Files already saved stay on this PC. You can resume later with Retry download.",
    confirmLabel: "Cancel download",
    cancelLabel: "Keep downloading",
    danger: true,
  });
  if (!ok) return;
  try {
    await cancelDownload();
  } catch {
    /* ignore */
  }
  downloadBusy = false;
  downloadSucceeded = false;
  downloadFailed = true;
  errorBanner = "Download cancelled. Use Retry download when you are ready to continue.";
  render();
}

function findLocalForCatalog(m: CatalogModel): LocalPackage | undefined {
  const safe = m.hf_repo.replace(/\//g, "__");
  return localPackages.find(
    (p) =>
      (p.hf_repo && p.hf_repo.toLowerCase() === m.hf_repo.toLowerCase()) ||
      p.folder_name.toLowerCase() === safe.toLowerCase(),
  );
}

async function refreshLocalPackages(): Promise<void> {
  try {
    localPackages = await listDownloadedModels();
  } catch {
    localPackages = [];
  }
  localPackagesLoaded = true;
  // Only re-render model step if we are still there and not mid-download.
  if (wizard.step === 1 && !downloadBusy && !downloadSucceeded) {
    render();
  }
}

/** After a successful download (or choosing an on-disk package), go to the next wizard step. */
async function deleteLocalPackage(p: LocalPackage): Promise<void> {
  const ok = await confirmAsync({
    title: "Delete this package?",
    message: `Remove "${p.hf_repo || p.folder_name}" from this PC? This cannot be undone. You can download it again later.`,
    confirmLabel: "Delete package",
    cancelLabel: "Keep it",
    danger: true,
  });
  if (!ok) return;
  try {
    await deleteDownloadedModel(p.path);
    if (wizard.modelPath === p.path) {
      wizard.modelPath = "";
      wizard.modelScan = null;
    }
    localPackagesLoaded = false;
    await refreshLocalPackages();
    errorBanner = null;
    render();
  } catch (e) {
    errorBanner = e instanceof Error ? e.message : String(e);
    render();
  }
}

async function finishDownloadAndAdvance(): Promise<void> {
  downloadSucceeded = false;
  downloadBusy = false;
  downloadFailed = false;
  errorBanner = null;
  if (!wizard.modelPath.trim()) {
    render();
    return;
  }
  try {
    wizard.modelScan = await scanModel(wizard.modelPath.trim());
    if (!wizard.modelScan.trainable) {
      downloadFailed = true;
      errorBanner =
        "That package is on this PC but does not look complete enough to teach. Use Re-download to repair it, or pick another package.";
      render();
      return;
    }
  } catch (e) {
    errorBanner = e instanceof Error ? e.message : String(e);
    render();
    return;
  }
  void refreshLocalPackages();
  wizard.step = 2;
  render();
}

function renderCatalogPicker(): HTMLElement {
  const wrap = el("div");
  wrap.appendChild(
    el(
      "p",
      "muted",
      "These are complete packages that start without stock refusal guardrails. Sized so teaching and the final chat file can run on typical NVIDIA gaming PCs (including 16 GB cards).",
    ),
  );

  // downloadBusy handled in stepModel (full page, no nav)

  // Dual size range + uncensored filter
  const filterCard = el("div", "card");
  filterCard.appendChild(el("h3", "card-title", "Package size"));
  filterCard.appendChild(
    el(
      "p",
      "muted",
      "Drag the left handle for the smallest size you want, and the right handle for the largest. After training you can still pick a lower quant so the chat file fits your graphics card.",
    ),
  );
  const rangeBox = el("div", "size-range");
  const labels = el("div", "size-range-labels");
  labels.appendChild(el("span", undefined, `Min ${formatParamsB(catalogMinB)}`));
  labels.appendChild(el("span", undefined, `Max ${formatParamsB(catalogMaxB)}`));
  rangeBox.appendChild(labels);
  const track = el("div", "size-range-track");
  const minRange = document.createElement("input");
  minRange.type = "range";
  minRange.min = String(SIZE_SLIDER_MIN);
  minRange.max = String(SIZE_SLIDER_MAX);
  minRange.step = "0.5";
  minRange.value = String(catalogMinB);
  minRange.setAttribute("aria-label", "Minimum model size in billions of parameters");
  const maxRange = document.createElement("input");
  maxRange.type = "range";
  maxRange.min = String(SIZE_SLIDER_MIN);
  maxRange.max = String(SIZE_SLIDER_MAX);
  maxRange.step = "0.5";
  maxRange.value = String(catalogMaxB);
  maxRange.setAttribute("aria-label", "Maximum model size in billions of parameters");
  const onRange = () => {
    let lo = Number(minRange.value);
    let hi = Number(maxRange.value);
    if (lo > hi) {
      // Keep thumbs from crossing: the one being moved wins
      if (document.activeElement === minRange) hi = lo;
      else lo = hi;
      minRange.value = String(lo);
      maxRange.value = String(hi);
    }
    catalogMinB = lo;
    catalogMaxB = hi;
    labels.replaceChildren();
    labels.appendChild(el("span", undefined, `Min ${formatParamsB(catalogMinB)}`));
    labels.appendChild(el("span", undefined, `Max ${formatParamsB(catalogMaxB)}`));
  };
  const onRangeEnd = () => {
    onRange();
    const visible = filterCatalog(
      MODEL_CATALOG,
      catalogMinB,
      catalogMaxB,
      catalogUncensoredOnly,
    );
    if (selectedCatalogId && !visible.some((m) => m.id === selectedCatalogId)) {
      selectedCatalogId = null;
    }
    render();
  };
  minRange.addEventListener("input", onRange);
  maxRange.addEventListener("input", onRange);
  minRange.addEventListener("change", onRangeEnd);
  maxRange.addEventListener("change", onRangeEnd);
  track.appendChild(minRange);
  track.appendChild(maxRange);
  rangeBox.appendChild(track);
  filterCard.appendChild(rangeBox);

  const uncLabel = document.createElement("label");
  uncLabel.style.display = "flex";
  uncLabel.style.alignItems = "flex-start";
  uncLabel.style.gap = "0.65rem";
  uncLabel.style.cursor = "pointer";
  uncLabel.style.marginTop = "var(--mc-space-3)";
  const uncCb = document.createElement("input");
  uncCb.type = "checkbox";
  uncCb.checked = catalogUncensoredOnly;
  uncCb.addEventListener("change", () => {
    catalogUncensoredOnly = uncCb.checked;
    const visible = filterCatalog(
      MODEL_CATALOG,
      catalogMinB,
      catalogMaxB,
      catalogUncensoredOnly,
    );
    if (selectedCatalogId && !visible.some((m) => m.id === selectedCatalogId)) {
      selectedCatalogId = null;
    }
    render();
  });
  uncLabel.appendChild(uncCb);
  uncLabel.appendChild(
    el(
      "span",
      undefined,
      "Prefer packages with fewer built-in refusals (uncensored / abliterated). Turn off to see strong standard packages in the same size range.",
    ),
  );
  filterCard.appendChild(uncLabel);
  wrap.appendChild(filterCard);

  const filteredCatalog = filterCatalog(
    MODEL_CATALOG,
    catalogMinB,
    catalogMaxB,
    catalogUncensoredOnly,
  );

  const onDisk = localPackages.filter((p) => p.complete || p.trainable);
  if (onDisk.length > 0) {
    const saved = el("div", "card");
    saved.appendChild(el("h3", "card-title", "Already on this PC"));
    saved.appendChild(
      el(
        "p",
        "card-body",
        "These packages were downloaded before. You can continue with one of them, or re-download to repair missing pieces.",
      ),
    );
    const list = el("div", "file-list");
    for (const p of onDisk) {
      const row = el("div", "file-row");
      const label = p.hf_repo || p.folder_name;
      const size =
        p.size_bytes != null ? ` · ${formatBytes(p.size_bytes)}` : "";
      const status = p.complete ? "Ready" : "Incomplete";
      row.appendChild(el("span", undefined, `${label}${size} (${status})`));
      const actions = el("div", "btn-row");
      actions.style.margin = "0";
      const useBtn = el("button", "btn btn-primary", "Use this package");
      useBtn.type = "button";
      useBtn.disabled = !p.trainable && !p.complete;
      useBtn.addEventListener("click", () => {
        wizard.modelPath = p.path;
        // Match catalog selection when possible
        const match = MODEL_CATALOG.find(
          (m) =>
            m.hf_repo.toLowerCase() === (p.hf_repo || "").toLowerCase() ||
            m.hf_repo.replace(/\//g, "__").toLowerCase() === p.folder_name.toLowerCase(),
        );
        if (match) selectedCatalogId = match.id;
        void finishDownloadAndAdvance();
      });
      const reBtn = el("button", "btn btn-secondary", "Re-download");
      reBtn.type = "button";
      reBtn.addEventListener("click", () => {
        const match =
          MODEL_CATALOG.find(
            (m) =>
              m.hf_repo.toLowerCase() === (p.hf_repo || "").toLowerCase() ||
              m.hf_repo.replace(/\//g, "__").toLowerCase() ===
                p.folder_name.toLowerCase(),
          ) || null;
        if (match) {
          selectedCatalogId = match.id;
          void startCatalogDownload(match);
        } else {
          errorBanner =
            "This folder is not in the recommended list. Pick a matching package below, or use I already have files.";
          render();
        }
      });
      const delBtn = el("button", "btn btn-danger-outline", "Delete");
      delBtn.type = "button";
      delBtn.addEventListener("click", () => void deleteLocalPackage(p));
      actions.appendChild(useBtn);
      actions.appendChild(reBtn);
      actions.appendChild(delBtn);
      row.appendChild(actions);
      list.appendChild(row);
    }
    saved.appendChild(list);
    wrap.appendChild(saved);
  }

  const freeGb = freeVramGb();
  const grid = el("div", "catalog-grid");
  if (!filteredCatalog.length) {
    wrap.appendChild(
      el("p", "muted", "No packages in this size range. Pick another size band."),
    );
  }
  for (const m of filteredCatalog) {
    const fit = fitForVram(m, freeGb);
    const local = findLocalForCatalog(m);
    const card = el("button", "catalog-card");
    card.type = "button";
    if (selectedCatalogId === m.id) card.classList.add("is-selected");
    card.appendChild(el("h4", undefined, m.name));
    card.appendChild(el("p", undefined, m.blurb));
    const meta = el("div", "catalog-meta");
    meta.appendChild(el("span", "badge badge-neutral", `~${m.params_b}B`));
    meta.appendChild(el("span", "badge badge-neutral", `Download ~${m.download_gb} GB`));
    if (local?.complete) {
      meta.appendChild(el("span", "badge badge-ok", "On this PC"));
    } else if (local && !local.complete) {
      meta.appendChild(el("span", "badge badge-warn", "Partial download"));
    }
    const fitBadge = el(
      "span",
      fit === "too_big" ? "badge badge-danger" : fit === "tight" ? "badge badge-warn" : "badge badge-ok",
      fitLabel(fit),
    );
    meta.appendChild(fitBadge);
    card.appendChild(meta);
    card.addEventListener("click", () => {
      selectedCatalogId = m.id;
      render();
    });
    grid.appendChild(card);
  }
  wrap.appendChild(grid);

  const selected = filteredCatalog.find((m) => m.id === selectedCatalogId);
  if (selected) {
    const local = findLocalForCatalog(selected);
    const actions = el("div", "catalog-selection");
    actions.id = "catalog-selection";
    actions.appendChild(el("h3", "card-title", selected.name));
    actions.appendChild(
      el(
        "p",
        "card-body",
        `This is a complete uncensored package (many large weight files), not a single chat file. Download is about ${selected.download_gb} GB. Teaching needs roughly ${selected.train_vram_gb} GB free graphics memory. After teaching, the chat file needs about ${selected.chat_vram_gb} GB.`,
      ),
    );
    if (local?.complete) {
      actions.appendChild(
        el(
          "p",
          "muted",
          `Already downloaded (${formatBytes(local.size_bytes)}). Path: ${local.path}`,
        ),
      );
    } else if (local && !local.complete) {
      actions.appendChild(
        el(
          "p",
          "muted",
          `A partial download is on this PC (${formatBytes(local.size_bytes)}). Re-download will resume and fill gaps.`,
        ),
      );
    }
    const row = el("div", "btn-row");
    if (local?.complete) {
      const useBtn = el("button", "btn btn-primary", "Continue with this package");
      useBtn.type = "button";
      useBtn.addEventListener("click", () => {
        wizard.modelPath = local.path;
        void finishDownloadAndAdvance();
      });
      const reBtn = el("button", "btn btn-secondary", "Re-download");
      reBtn.type = "button";
      reBtn.disabled =
        fitForVram(selected, freeGb) === "too_big" || downloadClickLock || downloadBusy;
      reBtn.addEventListener("click", () => void startCatalogDownload(selected));
      const delBtn = el("button", "btn btn-danger-outline", "Delete");
      delBtn.type = "button";
      delBtn.addEventListener("click", () => void deleteLocalPackage(local));
      row.appendChild(useBtn);
      row.appendChild(reBtn);
      row.appendChild(delBtn);
    } else {
      const dl = el(
        "button",
        "btn btn-primary",
        local ? "Resume / repair download" : "Download this package",
      );
      dl.type = "button";
      dl.disabled =
        fitForVram(selected, freeGb) === "too_big" || downloadClickLock || downloadBusy;
      dl.addEventListener("click", () => void startCatalogDownload(selected));
      row.appendChild(dl);
    }
    const openHf = el("button", "btn btn-secondary", "Show package files");
    openHf.type = "button";
    openHf.title = "Opens the file list so you can see the full package (config + weight files).";
    openHf.addEventListener("click", () => {
      void openExternal(selected.files_url);
    });
    row.appendChild(openHf);
    actions.appendChild(row);
    wrap.appendChild(actions);
  }

  return wrap;
}

async function startCatalogDownload(m: CatalogModel) {
  // Hard lock against double-clicks (confirm dialog + IPC can lag otherwise).
  if (downloadClickLock || downloadBusy) return;
  downloadClickLock = true;

  lastDownloadModelId = m.id;
  downloadFailed = false;
  downloadSucceeded = false;
  errorBanner = null;

  try {
    // Confirm FIRST with zero IPC - button feels instant.
    const ok = await confirmAsync({
      title: "Download this package?",
      message: `About ${m.download_gb} GB will download to this computer. An internet connection is required. Continue?`,
      confirmLabel: "Download",
      cancelLabel: "Not now",
    });
    if (!ok) return;

    // Paint the full download page immediately - no health check, no waiting.
    downloadBusy = true;
    downloadFailed = false;
    downloadSucceeded = false;
    downloadPct = 0;
    downloadBytesDone = 0;
    downloadBytesTotal = 0;
    downloadBytesRemaining = 0;
    downloadSpeedBps = 0;
    downloadEtaSec = null;
    downloadFilesDone = 0;
    downloadFilesTotal = 0;
    downloadCurrentFile = "";
    downloadMessage = "Starting download...";
    errorBanner = null;
    render();

    // Optional fast readiness (marker + python path only - never imports torch).
    // If this fails or is denied by ACL, still try the real download command.
    try {
      const ready = await canDownload();
      if (!ready) {
        downloadBusy = false;
        downloadFailed = true;
        errorBanner = "Finish the one-time setup first, then try Download again.";
        render();
        return;
      }
    } catch {
      // Ignore - download_hf_model will report a clear error if setup is missing.
    }

    if (downloadUnlisten) {
      downloadUnlisten();
      downloadUnlisten = null;
    }

    // Session-local flag so late process_exit cannot clear a successful download.
    let sessionDone = false;
    let lastProgressAt = Date.now();

    // Register listener BEFORE starting the worker so early events are not missed.
    downloadUnlisten = await onDownloadEvent((payload) => {
      const t = String(payload.type || "");
      if (t === "progress") {
        if (sessionDone) return;
        downloadBusy = true;
        downloadPct = Number(payload.pct ?? downloadPct);
        downloadMessage = String(payload.message || downloadMessage);
        if (payload.bytes_done != null) downloadBytesDone = Number(payload.bytes_done);
        if (payload.bytes_total != null) downloadBytesTotal = Number(payload.bytes_total);
        if (payload.bytes_remaining != null) {
          downloadBytesRemaining = Number(payload.bytes_remaining);
        }
        if (payload.speed_bps != null) downloadSpeedBps = Number(payload.speed_bps);
        if (payload.eta_sec != null && payload.eta_sec !== "") {
          downloadEtaSec = Number(payload.eta_sec);
        }
        if (payload.files_done != null) downloadFilesDone = Number(payload.files_done);
        if (payload.files_total != null) downloadFilesTotal = Number(payload.files_total);
        if (payload.current_file != null) {
          downloadCurrentFile = String(payload.current_file);
        }
        // Throttle full-page re-renders to keep UI responsive during large transfers.
        const now = Date.now();
        if (now - lastProgressAt >= 250 || downloadPct >= 100) {
          lastProgressAt = now;
          pushTrayStatus();
          render();
        }
      } else if (t === "done" && payload.path) {
        sessionDone = true;
        downloadSucceeded = true;
        downloadBusy = false;
        downloadFailed = false;
        downloadPct = 100;
        downloadBytesRemaining = 0;
        downloadMessage = "Download complete.";
        wizard.modelPath = String(payload.path);
        selectedCatalogId = m.id;
        render();
        void scanModel(wizard.modelPath).then((s) => {
          wizard.modelScan = s;
          if (!s.trainable) {
            downloadSucceeded = false;
            downloadFailed = true;
            errorBanner =
              "The download finished, but the package looks incomplete. Use Retry download to repair.";
          }
          render();
        });
      } else if (t === "error") {
        // Ignore late error events after a successful done
        if (sessionDone || downloadSucceeded) return;
        downloadBusy = false;
        downloadFailed = true;
        downloadSucceeded = false;
        errorBanner = plainError(
          String(payload.message || "Download failed. Use Retry download to resume."),
        );
        render();
      } else if (t === "process_exit") {
        const code = Number(payload.code ?? -1);
        // Success is ONLY "done". Exit 0 alone must never kick the user off the download page.
        if (sessionDone || downloadSucceeded) return;
        if (!downloadBusy) return;
        if (code === 130) {
          downloadBusy = false;
          downloadFailed = true;
          downloadSucceeded = false;
          if (!errorBanner) {
            errorBanner = "Download cancelled. Use Retry download to continue later.";
          }
          render();
          return;
        }
        if (code !== 0) {
          downloadBusy = false;
          downloadFailed = true;
          downloadSucceeded = false;
          if (!errorBanner) {
            errorBanner = "Download did not finish. Use Retry download to resume and repair.";
          }
          render();
          return;
        }
        // code === 0 without done: incomplete / silent failure
        downloadBusy = false;
        downloadFailed = true;
        downloadSucceeded = false;
        if (!errorBanner) {
          errorBanner = "Download ended unexpectedly. Use Retry download to resume.";
        }
        render();
      } else if (t === "log") {
        if (sessionDone) return;
        const msg = String(payload.message || "");
        if (/retry|repair|stall|resume/i.test(msg)) {
          downloadMessage = msg.length > 120 ? msg.slice(0, 117) + "..." : msg;
          render();
        }
      }
    });

    await downloadHfModel(m.hf_repo);
  } catch (e) {
    downloadBusy = false;
    downloadFailed = true;
    downloadSucceeded = false;
    errorBanner = plainError(e instanceof Error ? e.message : String(e));
    render();
  } finally {
    downloadClickLock = false;
  }
}

function renderLocalModelPicker(): HTMLElement {
  const wrap = el("div");
  wrap.appendChild(
    el(
      "p",
      "muted",
      "Use this if you already downloaded a full package folder. A single chat-ready file alone cannot be taught.",
    ),
  );

  const card = el("div", "card");
  const field = el("div", "field");
  field.appendChild(el("label", undefined, "Model location"));
  const row = el("div", "path-row");
  const input = el("input") as HTMLInputElement;
  input.type = "text";
  input.placeholder = "Choose a folder...";
  input.value = wizard.modelPath;
  input.addEventListener("change", () => {
    wizard.modelPath = input.value.trim();
  });
  row.appendChild(input);
  field.appendChild(row);

  const buttons = el("div", "btn-row");
  buttons.style.marginTop = "var(--mc-space-3)";
  const browseFolder = el("button", "btn btn-primary", "Choose folder");
  browseFolder.type = "button";
  browseFolder.addEventListener("click", async () => {
    const p = await pickModelFolder();
    if (!p) return;
    wizard.modelPath = p;
    input.value = p;
    wizard.modelScan = await scanModel(p);
    errorBanner = null;
    if (wizard.modelScan && !wizard.modelScan.trainable) {
      await showUnteachableModelPopup(wizard.modelScan.message, wizard.modelScan.help_tip);
    }
    render();
  });
  const browseFile = el("button", "btn btn-secondary", "I only have a single chat file");
  browseFile.type = "button";
  browseFile.addEventListener("click", async () => {
    const p = await pickModelFile();
    if (!p) return;
    wizard.modelPath = p;
    input.value = p;
    wizard.modelScan = await scanModel(p);
    errorBanner = null;
    if (wizard.modelScan && !wizard.modelScan.trainable) {
      await showUnteachableModelPopup(wizard.modelScan.message, wizard.modelScan.help_tip);
    }
    render();
  });
  buttons.appendChild(browseFolder);
  buttons.appendChild(browseFile);
  field.appendChild(buttons);
  card.appendChild(field);

  if (wizard.modelScan) {
    const scan = wizard.modelScan;
    const alert = el("div", scan.trainable ? "alert alert-ok" : "alert alert-warn");
    alert.appendChild(el("p", undefined, scan.message));
    card.appendChild(alert);
    if (!scan.trainable) {
      const switchTab = el("button", "btn btn-primary", "Browse recommended packages instead");
      switchTab.type = "button";
      switchTab.style.marginTop = "var(--mc-space-3)";
      switchTab.addEventListener("click", () => {
        modelSourceTab = "catalog";
        render();
      });
      card.appendChild(switchTab);
    }
  }
  wrap.appendChild(card);
  return wrap;
}

async function showUnteachableModelPopup(message: string, tip: string) {
  const detail =
    (message || "That selection cannot be taught as-is.") +
    "\n\n" +
    (tip ||
      "Teaching needs a full model package (a folder with config and weight files), not only a single chat-ready file. Use Recommended packages to download a full package. After teaching, ModelShaper creates a chat file you can use in LM Studio, Ollama, and similar apps.");
  await confirmAsync({
    title: "This is not a teachable package",
    message: detail,
    confirmLabel: "Got it",
    cancelLabel: "Close",
  });
}

function stepSkill(): HTMLElement {
  const box = el("div");
  box.appendChild(el("h1", "page-title", "Describe the skill"));
  box.appendChild(
    el(
      "p",
      "page-lead",
      "Name the skill and describe what should improve. You can start fresh or load a skill you saved earlier (includes materials when you load it).",
    ),
  );

  if (!materialPresetsLoaded) {
    void refreshMaterialPresets().then(() => {
      if (wizard.step === 2) render();
    });
  }

  // Load / create
  const pickCard = el("div", "card");
  pickCard.appendChild(el("h3", "card-title", "Saved skills"));
  pickCard.appendChild(
    el(
      "p",
      "card-body",
      "A saved skill stores the skill name, what should improve, training text, and document list so you can reuse them.",
    ),
  );
  const pickField = el("div", "field");
  pickField.appendChild(el("label", undefined, "Choose"));
  const sel = document.createElement("select");
  sel.style.width = "100%";
  sel.style.maxWidth = "32rem";
  sel.style.padding = "0.5rem 0.75rem";
  sel.style.borderRadius = "var(--mc-radius-sm)";
  sel.style.border = "1px solid var(--mc-border)";
  sel.style.background = "var(--mc-bg-elevated)";
  sel.style.color = "var(--mc-text)";
  const optNew = document.createElement("option");
  optNew.value = "";
  optNew.textContent = "Create a new skill";
  if (!activeSkillId) optNew.selected = true;
  sel.appendChild(optNew);
  for (const pr of materialPresets) {
    const opt = document.createElement("option");
    opt.value = pr.id;
    const sn = (pr.skill_name || pr.name || "Unnamed").trim();
    opt.textContent = sn + (pr.name && pr.name !== sn ? ` (${pr.name})` : "");
    if (activeSkillId === pr.id) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => {
    const id = sel.value;
    if (!id) {
      activeSkillId = null;
      wizard.skillName = "";
      wizard.skillDescription = "";
      // Keep materials unless user clears them - starting new skill clears materials for clarity
      wizard.materialsText = "";
      wizard.materialFiles = [];
      errorBanner = null;
      render();
      return;
    }
    const pr = materialPresets.find((p) => p.id === id);
    if (!pr) return;
    applySkillPreset(pr);
    render();
  });
  pickField.appendChild(sel);
  pickCard.appendChild(pickField);
  box.appendChild(pickCard);

  const card = el("div", "card");
  const nameField = el("div", "field");
  nameField.appendChild(el("label", undefined, "Skill name"));
  const name = el("input") as HTMLInputElement;
  name.type = "text";
  name.placeholder = "e.g. Customer support tone";
  name.value = wizard.skillName;
  name.addEventListener("input", () => {
    wizard.skillName = name.value;
  });
  nameField.appendChild(name);
  card.appendChild(nameField);

  const descField = el("div", "field");
  descField.appendChild(el("label", undefined, "What should improve?"));
  const desc = el("textarea") as HTMLTextAreaElement;
  desc.placeholder =
    "Describe the domain, style, vocabulary, or tasks you care about. Write as you would explain it to a colleague.";
  desc.value = wizard.skillDescription;
  desc.addEventListener("input", () => {
    wizard.skillDescription = desc.value;
  });
  descField.appendChild(desc);
  card.appendChild(descField);

  const saveRow = el("div", "btn-row");
  saveRow.style.marginTop = "var(--mc-space-3)";
  if (activeSkillId) {
    const saveOver = el("button", "btn btn-secondary", "Save changes to this skill");
    saveOver.type = "button";
    saveOver.addEventListener("click", () => void saveCurrentAsPreset(activeSkillId));
    saveRow.appendChild(saveOver);
  }
  const saveAs = el("button", "btn btn-secondary", activeSkillId ? "Save as a new skill" : "Save skill");
  saveAs.type = "button";
  saveAs.addEventListener("click", () => void saveCurrentAsPreset(null));
  saveRow.appendChild(saveAs);
  card.appendChild(saveRow);
  card.appendChild(
    el(
      "p",
      "muted",
      "Save stores skill name, what should improve, materials text, and documents. You can also save again on the materials page after adding files.",
    ),
  );
  box.appendChild(card);

  box.appendChild(
    navRow({
      back: () => {
        wizard.step = 1;
        render();
      },
      next: () => {
        wizard.skillName = name.value.trim();
        wizard.skillDescription = desc.value.trim();
        if (!wizard.skillName || !wizard.skillDescription) {
          errorBanner = "Add a skill name and description before continuing.";
          render();
          return;
        }
        errorBanner = null;
        wizard.step = 3;
        render();
      },
      nextLabel: "Continue",
    }),
  );
  return box;
}

function applySkillPreset(pr: MaterialPreset): void {
  activeSkillId = pr.id;
  wizard.skillName = (pr.skill_name || pr.name || "").trim();
  wizard.skillDescription = (pr.skill_description || "").trim();
  wizard.materialsText = pr.materials_text || "";
  wizard.materialFiles = (pr.material_files || []).map((f) => ({
    path: f.path,
    name: f.name,
    size_bytes: f.size_bytes || 0,
  }));
  errorBanner = null;
}

async function refreshMaterialPresets(): Promise<void> {
  try {
    materialPresets = await listMaterialPresets();
  } catch {
    materialPresets = [];
  }
  materialPresetsLoaded = true;
}

function stepMaterials(): HTMLElement {
  const box = el("div");
  box.appendChild(el("h1", "page-title", "Add materials"));
  box.appendChild(
    el(
      "p",
      "page-lead",
      "Provide the knowledge that should shape the model: notes, scripts, manuals, glossaries, or other documents. Everything stays on this PC. Save a preset to reuse the same materials on more than one model.",
    ),
  );

  if (!materialPresetsLoaded) {
    void refreshMaterialPresets().then(() => {
      if (wizard.step === 3) render();
    });
  }

  // Saved skill (same pack as Describe skill page)
  const presetCard = el("div", "card");
  presetCard.appendChild(el("h3", "card-title", "Save this skill"));
  presetCard.appendChild(
    el(
      "p",
      "card-body",
      "Saving stores the skill name, what should improve, the training text box, and every document listed below. Load skills from the Describe the skill page.",
    ),
  );
  if (activeSkillId) {
    const cur = materialPresets.find((p) => p.id === activeSkillId);
    presetCard.appendChild(
      el(
        "p",
        "muted",
        cur
          ? `Currently linked to saved skill: ${cur.skill_name || cur.name}`
          : "Currently linked to a saved skill.",
      ),
    );
  }
  const saveRow = el("div", "btn-row");
  saveRow.style.marginTop = "var(--mc-space-3)";
  if (activeSkillId) {
    const saveOver = el("button", "btn btn-primary", "Save changes to this skill");
    saveOver.type = "button";
    saveOver.addEventListener("click", () => void saveCurrentAsPreset(activeSkillId));
    saveRow.appendChild(saveOver);
  }
  const saveNew = el("button", "btn btn-secondary", "Save as a new skill");
  saveNew.type = "button";
  saveNew.addEventListener("click", () => void saveCurrentAsPreset(null));
  saveRow.appendChild(saveNew);
  presetCard.appendChild(saveRow);
  box.appendChild(presetCard);

  const card = el("div", "card");
  const zone = el("div", "drop-zone");
  zone.innerHTML = "<strong>Add files</strong> · PDF, Word, text, Markdown, CSV, JSON";
  const addBtn = el("div", "btn-row");
  addBtn.style.justifyContent = "center";
  addBtn.style.marginTop = "var(--mc-space-3)";
  const pick = el("button", "btn btn-secondary", "Choose files...");
  pick.type = "button";
  pick.addEventListener("click", async () => {
    const paths = await pickDocuments();
    for (const p of paths) {
      const name = p.split(/[/\\]/).pop() || p;
      if (!wizard.materialFiles.some((f) => f.path === p)) {
        wizard.materialFiles.push({ path: p, name, size_bytes: 0 });
      }
    }
    render();
  });
  addBtn.appendChild(pick);
  zone.appendChild(addBtn);
  card.appendChild(zone);

  if (wizard.materialFiles.length) {
    const ul = el("ul", "file-list");
    for (const f of wizard.materialFiles) {
      const li = el("li", "file-item");
      li.appendChild(el("span", "name", f.name));
      li.appendChild(el("span", "size", f.size_bytes ? formatBytes(f.size_bytes) : ""));
      const rm = el("button", "btn btn-ghost", "Remove");
      rm.type = "button";
      rm.addEventListener("click", () => {
        wizard.materialFiles = wizard.materialFiles.filter((x) => x.path !== f.path);
        render();
      });
      li.appendChild(rm);
      ul.appendChild(li);
    }
    card.appendChild(ul);
  }

  const textField = el("div", "field");
  textField.style.marginTop = "var(--mc-space-4)";
  textField.appendChild(el("label", undefined, "Or paste text"));
  const ta = el("textarea") as HTMLTextAreaElement;
  ta.placeholder = "Paste notes, examples, terminology, or style guidance...";
  ta.value = wizard.materialsText;
  ta.addEventListener("input", () => {
    wizard.materialsText = ta.value;
  });
  textField.appendChild(ta);
  card.appendChild(textField);

  // Website URL import
  const urlField = el("div", "field");
  urlField.style.marginTop = "var(--mc-space-4)";
  urlField.appendChild(el("label", undefined, "Or load text from a website"));
  urlField.appendChild(
    el(
      "p",
      "muted",
      "ModelShaper downloads the page and keeps readable text only. Best for articles and docs pages, not login walls or heavy apps.",
    ),
  );
  const urlRow = el("div", "path-row");
  const urlInput = el("input") as HTMLInputElement;
  urlInput.type = "url";
  urlInput.placeholder = "https://example.com/your-article";
  urlInput.value = materialsUrlInput;
  urlInput.addEventListener("change", () => {
    materialsUrlInput = urlInput.value.trim();
  });
  urlRow.appendChild(urlInput);
  const fetchBtn = el("button", "btn btn-secondary", "Fetch page text");
  fetchBtn.type = "button";
  fetchBtn.addEventListener("click", async () => {
    materialsUrlInput = urlInput.value.trim();
    if (!materialsUrlInput) {
      errorBanner = "Enter a website address first.";
      render();
      return;
    }
    fetchBtn.disabled = true;
    fetchBtn.textContent = "Fetching...";
    try {
      const text = await fetchUrlText(materialsUrlInput);
      const header = `\n\n--- From ${materialsUrlInput} ---\n\n`;
      wizard.materialsText = (wizard.materialsText.trim()
        ? wizard.materialsText.trim() + header
        : header.trimStart()) + text;
      errorBanner = null;
      render();
    } catch (e) {
      errorBanner = e instanceof Error ? e.message : String(e);
      render();
    }
  });
  urlRow.appendChild(fetchBtn);
  urlField.appendChild(urlRow);
  card.appendChild(urlField);

  box.appendChild(card);

  box.appendChild(
    navRow({
      back: () => {
        wizard.step = 2;
        render();
      },
      next: () => {
        if (!wizard.materialsText.trim() && wizard.materialFiles.length === 0) {
          errorBanner = "Add at least some text or a document before continuing.";
          render();
          return;
        }
        errorBanner = null;
        wizard.step = 4;
        void buildPlanAndRender();
      },
      nextLabel: "Continue",
    }),
  );
  return box;
}

async function saveCurrentAsPreset(existingId: string | null): Promise<void> {
  const skillName = wizard.skillName.trim();
  const skillDesc = wizard.skillDescription.trim();
  if (!skillName || !skillDesc) {
    errorBanner =
      "Fill in skill name and what should improve on the Describe the skill page before saving.";
    render();
    return;
  }
  if (!wizard.materialsText.trim() && wizard.materialFiles.length === 0) {
    errorBanner =
      "Add training text and/or documents before saving. Skill name alone is not enough.";
    render();
    return;
  }

  let id = (existingId || "").trim();
  let listName = skillName;
  if (id) {
    const existing = materialPresets.find((p) => p.id === id);
    listName = (existing?.name || skillName).trim() || skillName;
  } else {
    const entered = window.prompt(
      "Name for this saved skill (shown in your list). Defaults to the skill name:",
      skillName,
    );
    if (entered == null) return;
    listName = entered.trim() || skillName;
  }

  try {
    const saved = await saveMaterialPreset({
      id: id || "",
      name: listName,
      skill_name: skillName,
      skill_description: skillDesc,
      materials_text: wizard.materialsText,
      material_files: wizard.materialFiles.map((f) => ({
        path: f.path,
        name: f.name,
        size_bytes: f.size_bytes || 0,
      })),
      updated_at: 0,
    });
    activeSkillId = saved.id;
    materialPresetsLoaded = false;
    await refreshMaterialPresets();
    errorBanner = null;
    // Brief confirmation via muted path: re-render with selection
    render();
  } catch (e) {
    errorBanner = e instanceof Error ? e.message : String(e);
    render();
  }
}

/** Map train length to step counts (overrides power-mode defaults). */
function stepsForTrainLength(len: WizardState["trainLength"]): number {
  switch (len) {
    case "quick":
      return 50;
    case "thorough":
      return 200;
    default:
      return 100;
  }
}

function applyTrainLengthToPlan(): void {
  if (!wizard.plan) return;
  wizard.plan = {
    ...wizard.plan,
    max_steps: stepsForTrainLength(wizard.trainLength),
  };
}

async function buildPlanAndRender(opts?: { quiet?: boolean }) {
  const materialBytes =
    wizard.materialsText.length +
    wizard.materialFiles.reduce((a, f) => a + (f.size_bytes || 5000), 0);
  try {
    // Fresh hardware snapshot so free GPU memory is current (e.g. after closing LM Studio).
    try {
      hw = await getHardwareSnapshot();
    } catch {
      /* keep last */
    }
    wizard.plan = await planTraining({
      modelPath: wizard.modelPath,
      powerMode: wizard.powerMode,
      materialBytes,
      skillName: wizard.skillName,
    });
    applyTrainLengthToPlan();
    if (!opts?.quiet) {
      errorBanner = null;
    }
  } catch (e) {
    errorBanner = e instanceof Error ? e.message : String(e);
  }
  render();
}

function stepReview(): HTMLElement {
  const box = el("div");
  box.appendChild(el("h1", "page-title", "Review plan"));
  box.appendChild(
    el(
      "p",
      "page-lead",
      "ModelShaper picked settings from your current free memory and GPU. Choose how hard to push this PC, then start when ready.",
    ),
  );

  const modes = el("div", "mode-grid");
  (
    [
      ["gentle", "Gentle", "Lowest impact. Takes longer."],
      ["balanced", "Balanced", "Recommended for most PCs."],
      ["faster", "Faster", "Uses more resources. May slow other apps."],
    ] as const
  ).forEach(([id, title, desc]) => {
    const btn = el("button", "mode-card");
    btn.type = "button";
    if (wizard.powerMode === id) btn.classList.add("is-selected");
    btn.appendChild(el("h4", undefined, title));
    btn.appendChild(el("p", undefined, desc));
    btn.addEventListener("click", () => {
      wizard.powerMode = id;
      void buildPlanAndRender();
    });
    modes.appendChild(btn);
  });
  box.appendChild(modes);
  modes.style.marginBottom = "var(--mc-space-4)";

  // How long / how many steps
  const lengthCard = el("div", "card");
  lengthCard.appendChild(el("h3", "card-title", "How long to train"));
  lengthCard.appendChild(
    el(
      "p",
      "card-body",
      "Steps are how many times the model practices on your materials. More steps usually learn more (and take longer). Too many with very little text can make answers sound stiff or repetitive. Use Standard unless you know you want a shorter or longer run.",
    ),
  );
  const lenGrid = el("div", "mode-grid");
  (
    [
      [
        "quick",
        "Quick",
        `${stepsForTrainLength("quick")} steps - faster finish, lighter learning`,
      ],
      [
        "standard",
        "Standard",
        `${stepsForTrainLength("standard")} steps - good default for most jobs`,
      ],
      [
        "thorough",
        "Thorough",
        `${stepsForTrainLength("thorough")} steps - longer run, more practice on your materials`,
      ],
    ] as const
  ).forEach(([id, title, desc]) => {
    const btn = el("button", "mode-card");
    btn.type = "button";
    if (wizard.trainLength === id) btn.classList.add("is-selected");
    btn.appendChild(el("h4", undefined, title));
    btn.appendChild(el("p", undefined, desc));
    btn.addEventListener("click", () => {
      wizard.trainLength = id;
      applyTrainLengthToPlan();
      render();
    });
    lenGrid.appendChild(btn);
  });
  lengthCard.appendChild(lenGrid);
  box.appendChild(lengthCard);
  lengthCard.style.marginBottom = "var(--mc-space-4)";

  // Chat file quality after training (GGUF quant) - target ~90% of total GPU VRAM.
  const vramTotal = hw?.primary_gpu?.vram_total_mb ?? 0;
  const paramsB =
    wizard.modelScan?.estimated_params_b ??
    estimateParamsB(wizard.modelPath, 8);
  const quantOpts = planChatQuants(paramsB, vramTotal || 12288, 0.9);
  const quantCard = el("div", "card");
  quantCard.appendChild(el("h3", "card-title", "Chat file quality (after training)"));
  quantCard.appendChild(
    el(
      "p",
      "card-body",
      `When training finishes, ModelShaper builds a chat file for LM Studio. Higher quality uses more of your ${vramTotal ? formatMb(vramTotal) : "GPU"} memory (we aim near 90%, not a timid 75%). Smaller files are dumber. Pick auto for the largest that fits, or choose manually.`,
    ),
  );
  const qGrid = el("div", "mode-grid");
  // Auto option
  const autoBtn = el("button", "mode-card");
  autoBtn.type = "button";
  if (wizard.exportQuant === "auto") autoBtn.classList.add("is-selected");
  const rec = quantOpts.find((q) => q.recommended);
  autoBtn.appendChild(el("h4", undefined, "Auto (recommended)"));
  autoBtn.appendChild(
    el(
      "p",
      undefined,
      rec
        ? `Uses ${rec.label} - largest that fits ~90% of your GPU (~${formatMb(rec.est_vram_mb)} est.)`
        : "Picks the largest quant that fits this GPU.",
    ),
  );
  autoBtn.addEventListener("click", () => {
    wizard.exportQuant = "auto";
    render();
  });
  qGrid.appendChild(autoBtn);
  for (const q of quantOpts) {
    const btn = el("button", "mode-card");
    btn.type = "button";
    if (wizard.exportQuant === q.id) btn.classList.add("is-selected");
    btn.appendChild(
      el("h4", undefined, `${q.label}${q.recommended ? " ★" : ""}`),
    );
    btn.appendChild(
      el(
        "p",
        undefined,
        `~${q.est_file_gb} GB file · ~${formatMb(q.est_vram_mb)} GPU est. ${q.blurb}`,
      ),
    );
    btn.addEventListener("click", () => {
      wizard.exportQuant = q.id as WizardState["exportQuant"];
      render();
    });
    qGrid.appendChild(btn);
  }
  quantCard.appendChild(qGrid);
  box.appendChild(quantCard);
  quantCard.style.marginBottom = "var(--mc-space-4)";

  const card = el("div", "card");
  const planHead = el("div", "progress-head");
  planHead.style.marginBottom = "var(--mc-space-3)";
  planHead.appendChild(el("h3", "card-title", "Adaptation plan"));
  const recheck = el("button", "btn btn-secondary", "Recheck this PC");
  recheck.type = "button";
  recheck.title = "Refresh free graphics memory and rebuild the plan (use after closing other apps)";
  recheck.addEventListener("click", () => {
    void buildPlanAndRender();
  });
  planHead.appendChild(recheck);
  card.appendChild(planHead);

  if (!wizard.plan) {
    card.appendChild(el("p", "muted", "Building plan..."));
  } else {
    const p = wizard.plan;
    card.appendChild(el("p", "card-body", p.summary));

    const meta = el("p", "card-body");
    meta.style.marginTop = "var(--mc-space-3)";
    meta.textContent = `Estimated GPU memory: ${formatMb(p.estimated_vram_mb)} · Context length: ${p.max_seq_length} · Steps: ${p.max_steps}`;
    card.appendChild(meta);

    if (p.hard_blocks.length) {
      const tip = el(
        "p",
        "muted",
        "If you closed another app to free graphics memory, click Recheck this PC - the plan does not update by itself.",
      );
      tip.style.marginTop = "var(--mc-space-2)";
      card.appendChild(tip);
    }

    for (const w of p.soft_warnings) {
      const a = el("div", "alert alert-warn", w);
      a.style.marginTop = "var(--mc-space-3)";
      card.appendChild(a);
    }
    for (const b of p.hard_blocks) {
      const a = el("div", "alert alert-danger", b);
      a.style.marginTop = "var(--mc-space-3)";
      card.appendChild(a);
    }
  }
  box.appendChild(card);

  const exportCard = el("div", "card");
  const field = el("div", "field");
  field.appendChild(el("label", undefined, "Export folder"));
  const pathRow = el("div", "path-row");
  const input = el("input") as HTMLInputElement;
  input.type = "text";
  input.placeholder = "Where finished files should be saved";
  input.value = wizard.exportDir;
  input.addEventListener("change", () => {
    wizard.exportDir = input.value.trim();
  });
  const browse = el("button", "btn btn-secondary", "Browse...");
  browse.type = "button";
  browse.addEventListener("click", async () => {
    const d = await pickExportDir();
    if (d) {
      wizard.exportDir = d;
      input.value = d;
    }
  });
  pathRow.appendChild(input);
  pathRow.appendChild(browse);
  field.appendChild(pathRow);
  exportCard.appendChild(field);
  box.appendChild(exportCard);

  // Liability acceptance - required before training
  const terms = el("div", "terms-panel");
  terms.appendChild(el("h3", "card-title", "Before you continue"));
  terms.appendChild(
    el(
      "p",
      "card-body",
      "ModelShaper and any models or files it creates are provided as-is, without warranties. You are solely responsible for how you use this software and those files, including compliance with laws and third-party terms. The developer accepts no liability for misuse, damages, or consequences arising from use of this tool or its outputs.",
    ),
  );
  const checkRow = el("div", "field");
  checkRow.style.marginTop = "var(--mc-space-3)";
  checkRow.style.marginBottom = "0";
  const label = document.createElement("label");
  label.style.display = "flex";
  label.style.alignItems = "flex-start";
  label.style.gap = "0.65rem";
  label.style.cursor = "pointer";
  label.style.fontWeight = "var(--mc-fw-medium)";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = liabilityAccepted;
  cb.style.marginTop = "0.2rem";
  cb.addEventListener("change", () => {
    liabilityAccepted = cb.checked;
    render();
  });
  label.appendChild(cb);
  const labText = el(
    "span",
    undefined,
    "I have read and accept these terms. I use ModelShaper and its outputs at my own risk.",
  );
  label.appendChild(labText);
  checkRow.appendChild(label);
  terms.appendChild(checkRow);
  terms.id = "terms-panel";
  box.appendChild(terms);

  box.appendChild(
    navRow({
      back: () => {
        wizard.step = 3;
        render();
      },
      next: async () => {
        if (!liabilityAccepted) {
          errorBanner = "Please check the box to accept the terms before starting.";
          render();
          return;
        }
        if (!wizard.exportDir.trim()) {
          errorBanner = "Choose an export folder before starting training.";
          render();
          return;
        }
        if (!wizard.modelScan?.trainable) {
          errorBanner = "Choose a full model package before starting.";
          render();
          return;
        }

        // Always re-check GPU/memory right before start (covers closing LM Studio after a warning).
        errorBanner = null;
        await buildPlanAndRender({ quiet: true });
        if (wizard.plan?.hard_blocks?.length) {
          errorBanner =
            wizard.plan.hard_blocks[0] +
            " Free up graphics memory, then click Recheck this PC (or Start training again).";
          render();
          return;
        }
        if (engineStatus?.needs_setup || !engineStatus?.healthy) {
          // Refresh engine status once in case setup finished earlier.
          try {
            engineStatus = await getEngineStatus();
          } catch {
            /* keep */
          }
        }
        if (engineStatus?.needs_setup || !engineStatus?.healthy) {
          const go = await confirmAsync({
            title: "Setup is not finished",
            message: "Finish the one-time setup before starting. Open setup now?",
            confirmLabel: "Open setup",
            cancelLabel: "Stay here",
          });
          if (go) {
            view = "setup";
            render();
          }
          return;
        }
        if (wizard.plan?.soft_warnings?.length) {
          const ok = await confirmAsync({
            title: "Start with notes?",
            message:
              wizard.plan.soft_warnings.join(" ") +
              " You can still start. Choose Cancel if you want to free more memory first.",
            confirmLabel: "Start training",
            cancelLabel: "Not yet",
          });
          if (!ok) return;
        }
        errorBanner = null;
        // Always persist full skill pack before a long job so nothing is lost if training fails.
        try {
          if (
            wizard.skillName.trim() &&
            wizard.skillDescription.trim() &&
            (wizard.materialsText.trim() || wizard.materialFiles.length > 0)
          ) {
            await saveCurrentAsPreset(activeSkillId);
          }
        } catch {
          /* non-fatal - training can still start */
        }
        wizard.step = 5;
        wizard.trainingActive = true;
        wizard.trainingPaused = false;
        wizard.progressPct = 0;
        wizard.progressLabel = "Starting training...";
        trainTiming = {
          startedAt: Date.now(),
          lastStep: 0,
          maxSteps: wizard.plan?.max_steps ?? stepsForTrainLength(wizard.trainLength),
          etaLabel: "Estimating time…",
        };
        wizard.logs = [
          `Starting training (${wizard.plan?.max_steps ?? stepsForTrainLength(wizard.trainLength)} steps)...`,
        ];
        wizard.exportPaths = null;
        render();
        void beginRealTraining();
      },
      nextLabel: "Start training",
    }),
  );
  return box;
}

async function beginRealTraining() {
  try {
    if (trainUnlisten) {
      trainUnlisten();
      trainUnlisten = null;
    }
    trainUnlisten = await onTrainingEvent((payload) => {
      handleTrainingEvent(payload);
    });
    await startTraining({
      modelPath: wizard.modelPath,
      skillName: wizard.skillName,
      skillDescription: wizard.skillDescription,
      materialsText: wizard.materialsText,
      files: wizard.materialFiles.map((f) => f.path),
      exportDir: wizard.exportDir,
      powerMode: wizard.powerMode,
      exportQuant: wizard.exportQuant || "auto",
      vramTotalMb: hw?.primary_gpu?.vram_total_mb,
      maxSteps: wizard.plan?.max_steps ?? stepsForTrainLength(wizard.trainLength),
    });
  } catch (e) {
    wizard.trainingActive = false;
    errorBanner = e instanceof Error ? e.message : String(e);
    wizard.logs.push(errorBanner);
    wizard.progressLabel = "Failed to start";
    render();
  }
}

function handleTrainingEvent(payload: Record<string, unknown>) {
  const t = String(payload.type || "");
  if (t === "log" || t === "dataset" || t === "plan") {
    if (payload.message) wizard.logs.push(String(payload.message));
    if (t === "dataset" && payload.examples != null) {
      wizard.logs.push(`Dataset ready: ${payload.examples} examples`);
    }
    if (t === "plan" && payload.summary) {
      wizard.logs.push(String(payload.summary));
    }
    // keep last ~80 lines
    if (wizard.logs.length > 80) wizard.logs = wizard.logs.slice(-80);
    render();
    return;
  }
  if (t === "progress") {
    const step = Number(payload.step ?? 0);
    const max = Number(payload.max_steps ?? 100) || 100;
    wizard.progressPct = Math.min(100, Math.round((step / max) * 100));
    wizard.progressLabel = String(payload.message || `Step ${step} of ${max}`);
    if (trainTiming) {
      trainTiming.lastStep = step;
      trainTiming.maxSteps = max;
      trainTiming.etaLabel = formatTrainEta(trainTiming.startedAt, step, max, wizard.progressLabel);
    }
    if (payload.loss != null) {
      wizard.logs.push(`step ${step}: loss ${payload.loss}`);
      if (wizard.logs.length > 80) wizard.logs = wizard.logs.slice(-80);
    }
    pushTrayStatus();
    render();
    return;
  }
  if (t === "error") {
    wizard.trainingActive = false;
    wizard.trainingPaused = false;
    trainTiming = null;
    errorBanner = String(payload.message || "Training failed.");
    wizard.logs.push(errorBanner);
    wizard.progressLabel = "Failed";
    render();
    return;
  }
  if (t === "done") {
    wizard.trainingActive = false;
    wizard.trainingPaused = false;
    trainTiming = null;
    wizard.progressPct = 100;
    wizard.progressLabel = "Complete";
    wizard.logs.push("Training finished.");
    void setTrayTooltip("Training complete");
    const exports = (payload.exports || {}) as Record<string, string | null | undefined>;
    wizard.exportPaths = {
      gguf: exports.gguf || undefined,
      lora: exports.lora || undefined,
      modelfile: exports.modelfile || undefined,
    };
    if (!wizard.exportPaths.gguf && !wizard.exportPaths.lora) {
      wizard.exportPaths = {
        lora: wizard.exportDir + "\\lora",
        modelfile: wizard.exportDir + "\\Modelfile",
      };
    }
    wizard.step = 6;
    render();
    return;
  }
  if (t === "process_exit") {
    const code = Number(payload.code ?? -1);
    if (wizard.trainingActive && code !== 0) {
      wizard.trainingActive = false;
      wizard.progressLabel = "Stopped";
      if (!errorBanner) {
        errorBanner = `Training process exited with code ${code}.`;
        wizard.logs.push(errorBanner);
      }
      render();
    }
  }
}

/** Human ETA from elapsed time and completed steps (training phase only). */
function formatTrainEta(
  startedAt: number,
  step: number,
  maxSteps: number,
  label: string,
): string {
  const lower = label.toLowerCase();
  if (
    lower.includes("saving") ||
    lower.includes("export") ||
    lower.includes("building") ||
    lower.includes("merge") ||
    lower.includes("chat file") ||
    lower.includes("gguf")
  ) {
    return "Finishing export (time varies)…";
  }
  if (step <= 0 || maxSteps <= 0) return "Estimating time…";
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs < 4000) return "Estimating time…";
  const msPerStep = elapsedMs / Math.max(step, 1);
  const remainingSteps = Math.max(0, maxSteps - step);
  // Export/merge after train often takes a few minutes on 7-9B models.
  const exportPadMs = step >= maxSteps ? 0 : 3 * 60 * 1000;
  let remainingMs = remainingSteps * msPerStep + (remainingSteps > 0 ? exportPadMs * 0.15 : 0);
  if (step >= maxSteps) {
    return "Training steps done - building export files...";
  }
  remainingMs = Math.max(0, remainingMs);
  const totalSec = Math.round(remainingMs / 1000);
  if (totalSec < 60) return `About ${totalSec}s remaining`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) {
    return sec > 5 ? `About ${min}m ${sec}s remaining` : `About ${min} min remaining`;
  }
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `About ${hr}h ${remMin}m remaining`;
}

function stepTrain(): HTMLElement {
  const box = el("div");
  box.appendChild(el("h1", "page-title", "Training"));
  box.appendChild(
    el(
      "p",
      "page-lead",
      "The job runs at reduced priority so this PC stays usable. You can pause or cancel anytime.",
    ),
  );

  const card = el("div", "card");
  const pb = el("div", "progress-block");
  const head = el("div", "progress-head");
  head.appendChild(el("span", undefined, wizard.progressLabel));
  head.appendChild(el("span", undefined, `${Math.round(wizard.progressPct)}%`));
  pb.appendChild(head);
  const track = el("div", "progress-track");
  const fill = el("div", "progress-fill");
  fill.style.width = `${wizard.progressPct}%`;
  track.appendChild(fill);
  pb.appendChild(track);
  if (wizard.trainingActive || trainTiming) {
    const eta = el(
      "p",
      "progress-meta",
      trainTiming?.etaLabel ||
        (wizard.trainingActive ? "Estimating time…" : ""),
    );
    if (eta.textContent) pb.appendChild(eta);
  }
  card.appendChild(pb);

  const log = el("div", "log-box");
  log.textContent = wizard.logs.join("\n") || "Waiting for events...";
  // Pin to newest lines so monitoring stays useful during long jobs.
  requestAnimationFrame(() => {
    log.scrollTop = log.scrollHeight;
  });
  card.appendChild(log);
  box.appendChild(card);

  const row = el("div", "btn-row");
  if (wizard.trainingActive) {
    const pause = el(
      "button",
      "btn btn-secondary",
      wizard.trainingPaused ? "Resume" : "Pause",
    );
    pause.type = "button";
    pause.addEventListener("click", async () => {
      if (wizard.trainingPaused) {
        try {
          await resumeTraining();
          wizard.trainingPaused = false;
          wizard.logs.push("Resume requested.");
          render();
        } catch (e) {
          errorBanner = e instanceof Error ? e.message : String(e);
          render();
        }
        return;
      }
      const ok = await confirmAsync({
        title: "Pause training?",
        message: "The job will pause after the current step. Resume when you are ready.",
        confirmLabel: "Pause job",
        cancelLabel: "Keep running",
      });
      if (!ok) return;
      try {
        await pauseTraining();
        wizard.trainingPaused = true;
        wizard.logs.push("Pause requested.");
        render();
      } catch (e) {
        errorBanner = e instanceof Error ? e.message : String(e);
        render();
      }
    });

    const cancel = el("button", "btn btn-danger-outline", "Cancel job");
    cancel.type = "button";
    cancel.addEventListener("click", async () => {
      const ok = await confirmAsync({
        title: "Cancel training?",
        message: "Progress after the last checkpoint will be lost. This cannot be undone.",
        confirmLabel: "Cancel job",
        cancelLabel: "Keep running",
        danger: true,
      });
      if (!ok) return;
      try {
        await cancelTraining();
        wizard.trainingActive = false;
        wizard.trainingPaused = false;
        trainTiming = null;
        wizard.logs.push("Cancel requested.");
        wizard.progressLabel = "Cancelled";
        render();
      } catch (e) {
        errorBanner = e instanceof Error ? e.message : String(e);
        render();
      }
    });
    row.appendChild(pause);
    row.appendChild(cancel);
  } else {
    const back = el("button", "btn btn-secondary", "Back to plan");
    back.type = "button";
    back.addEventListener("click", () => {
      wizard.step = 4;
      render();
    });
    row.appendChild(back);
    if (wizard.modelPath && wizard.skillName && (wizard.materialsText || wizard.materialFiles.length)) {
      const again = el("button", "btn btn-primary", "Train again");
      again.type = "button";
      again.title =
        "Start another training run with the same skill and materials. Uses a new LoRA adapter - the original base model files are not permanently changed.";
      again.addEventListener("click", () => void startTrainAgain());
      row.appendChild(again);
    }
  }
  box.appendChild(row);
  return box;
}

/** Fresh LoRA run with same skill/materials/model - base weights stay frozen; safe to re-run. */
async function startTrainAgain(): Promise<void> {
  if (wizard.trainingActive || downloadBusy) {
    errorBanner = "Wait for the current job to finish first.";
    render();
    return;
  }
  if (!wizard.modelPath.trim() || !wizard.skillName.trim()) {
    errorBanner = "Need a model and skill to train again.";
    render();
    return;
  }
  if (!wizard.materialsText.trim() && wizard.materialFiles.length === 0) {
    errorBanner = "Need materials to train again.";
    render();
    return;
  }
  const ok = await confirmAsync({
    title: "Train again with this skill?",
    message:
      "This starts a new training run using the same model, skill, and materials. " +
      "ModelShaper trains a separate adapter (LoRA) and does not permanently rewrite the base model files. " +
      "Useful after a failed run or when you want more practice on the same content. " +
      "Choose Thorough on the next screen if you want a longer run.",
    confirmLabel: "Go to review",
    cancelLabel: "Cancel",
  });
  if (!ok) return;
  // Auto-save skill pack so nothing is lost between runs
  try {
    if (wizard.skillName.trim() && wizard.skillDescription.trim()) {
      if (activeSkillId || wizard.materialsText || wizard.materialFiles.length) {
        await saveCurrentAsPreset(activeSkillId);
      }
    }
  } catch {
    /* non-fatal */
  }
  wizard.trainingActive = false;
  wizard.trainingPaused = false;
  trainTiming = null;
  wizard.progressPct = 0;
  wizard.progressLabel = "Not started";
  wizard.logs = [];
  wizard.exportPaths = null;
  wizard.step = 4;
  errorBanner = null;
  void buildPlanAndRender();
}

function stepExport(): HTMLElement {
  const box = el("div");
  box.appendChild(el("h1", "page-title", "Export & next steps"));
  box.appendChild(
    el(
      "p",
      "page-lead",
      "Your adapted model is ready. Use the chat file (.gguf) in any of the apps below - not only one brand.",
    ),
  );

  const card = el("div", "card");
  card.appendChild(el("h3", "card-title", "Outputs"));
  if (wizard.exportPaths) {
    const ul = el("ul", "setup-list");
    if (wizard.exportPaths.gguf) {
      ul.appendChild(el("li", undefined, `Chat file (GGUF): ${wizard.exportPaths.gguf}`));
    }
    if (wizard.exportPaths.lora) {
      ul.appendChild(el("li", undefined, `Extra files folder: ${wizard.exportPaths.lora}`));
    }
    if (wizard.exportPaths.modelfile) {
      ul.appendChild(el("li", undefined, `Ollama Modelfile: ${wizard.exportPaths.modelfile}`));
    }
    card.appendChild(ul);
    if (wizard.exportDir) {
      const openBtn = el("button", "btn btn-secondary", "Open export folder");
      openBtn.type = "button";
      openBtn.style.marginTop = "var(--mc-space-3)";
      openBtn.addEventListener("click", () => {
        void openPath(wizard.exportDir).catch((e) => {
          errorBanner =
            "Could not open the export folder. Check that the path still exists: " +
            wizard.exportDir +
            (e instanceof Error ? ` (${e.message})` : "");
          render();
        });
      });
      card.appendChild(openBtn);
    }
  } else {
    card.appendChild(el("p", "card-body", "No export yet."));
  }
  box.appendChild(card);

  const settingsCard = el("div", "card");
  settingsCard.appendChild(el("h3", "card-title", "Suggested chat settings"));
  const settingsBody = el("p", "card-body");
  settingsBody.style.whiteSpace = "pre-wrap";
  settingsBody.textContent =
    "These are solid starting points for a ModelShaper skill teach. Adjust after a few test chats.\n\n" +
    "Temperature: 0.65\n" +
    "  • 0.4-0.5 if you want tighter, more factual answers\n" +
    "  • 0.75-0.85 if answers feel stiff or too short\n\n" +
    "Top P: 0.90\n" +
    "Top K: 40\n" +
    "Repeat penalty: 1.05-1.15 (raise a little if it loops the same phrases)\n" +
    "Context length: 4096-8192 if your GPU can hold it\n\n" +
    "System prompt: a short reminder of the skill you trained\n" +
    `  Example: ${wizard.skillDescription.trim() || wizard.skillName.trim() || "You are a helpful specialist in the skill you trained."}\n\n` +
    "Tips:\n" +
    "• Stick to questions that match how you wrote your materials.\n" +
    "• If it echoes website ads or navigation junk, clean the materials and train again.\n" +
    "• The same numbers are written into README-LM-STUDIO.txt and the Ollama Modelfile in your export folder.";
  settingsCard.appendChild(settingsBody);
  box.appendChild(settingsCard);

  const guides: { title: string; body: string }[] = [
    {
      title: "LM Studio",
      body:
        "1. Open LM Studio.\n2. Use Import / My Models and point at the .gguf file (or copy it into your LM Studio models folder).\n3. Load the model and chat.\n4. Set temperature and related options to the values above (My Models → load → settings / inference).\nTip: prefer the higher-quality quant you chose on Review if your GPU can hold it.",
    },
    {
      title: "Ollama (Windows)",
      body:
        "1. Install Ollama for Windows if needed.\n2. Open a terminal in the export folder (Open export folder, then address bar → type cmd).\n3. Run: ollama create my-skill -f Modelfile\n4. Run: ollama run my-skill\nThe Modelfile already includes temperature and related parameters.",
    },
    {
      title: "KoboldCpp",
      body:
        "1. Open KoboldCpp.\n2. Load Model → pick the .gguf from your export folder.\n3. Start the server / UI and chat as usual.\n4. Match temperature / top_p to the suggested settings above when the UI offers them.",
    },
    {
      title: "Jan",
      body:
        "1. Open Jan.\n2. Import Model / add a local model and select the .gguf file.\n3. Create a thread and chat.\n4. Use the suggested temperature and sampling settings when available.\nAny app that loads GGUF the same way (including many llama.cpp front-ends) will work similarly.",
    },
  ];
  for (const g of guides) {
    const c = el("div", "card");
    c.appendChild(el("h3", "card-title", g.title));
    const p = el("p", "card-body");
    p.style.whiteSpace = "pre-wrap";
    p.textContent = g.body;
    c.appendChild(p);
    box.appendChild(c);
  }

  if (wizard.modelPath && wizard.skillName && (wizard.materialsText || wizard.materialFiles.length)) {
    const againRow = el("div", "btn-row");
    againRow.style.marginBottom = "var(--mc-space-4)";
    const again = el("button", "btn btn-primary", "Train again with this skill");
    again.type = "button";
    again.addEventListener("click", () => void startTrainAgain());
    againRow.appendChild(again);
    againRow.appendChild(
      el(
        "p",
        "muted",
        "Starts another LoRA training run. The base model on disk is not permanently rewritten.",
      ),
    );
    box.appendChild(againRow);
  }

  box.appendChild(
    navRow({
      next: async () => {
        const ok = await confirmAsync({
          title: "Start a new skill?",
          message: "This clears the current wizard selections. Exported files on disk are not deleted.",
          confirmLabel: "Start new",
          cancelLabel: "Stay here",
        });
        if (!ok) return;
        activeSkillId = null;
        Object.assign(wizard, {
          step: 0,
          skillName: "",
          skillDescription: "",
          modelPath: "",
          modelScan: null,
          materialsText: "",
          materialFiles: [],
          powerMode: "balanced",
          exportQuant: "auto",
          trainLength: "standard",
          plan: null,
          trainingActive: false,
          trainingPaused: false,
          progressPct: 0,
          progressLabel: "Not started",
          logs: [],
          exportPaths: null,
        } satisfies Partial<WizardState>);
        render();
      },
      nextLabel: "Start another skill",
      hideBack: true,
    }),
  );
  return box;
}

function renderHelp(): HTMLElement {
  const box = el("div");
  box.appendChild(el("h1", "page-title", "Help"));
  box.appendChild(
    el(
      "p",
      "page-lead",
      "This guide is for people who have never trained a model before. You do not need programming knowledge. ModelShaper walks you through the steps on this PC.",
    ),
  );

  const sections: { title: string; body: string }[] = [
    {
      title: "What you need on this PC",
      body:
        "ModelShaper.exe is the app shell. It does not include Python or the full training libraries (those are large GPU packages).\n\n" +
        "Required:\n" +
        "- Windows 10/11 with WebView2 (included with Edge on most PCs; Windows 11 usually has it already)\n" +
        "- Python 3.10 or newer from python.org, with \"Add python.exe to PATH\" checked during install\n" +
        "- An NVIDIA graphics card and a current NVIDIA driver (nvidia-smi must work)\n" +
        "- Internet for first-time setup (to add only missing training libraries) and for downloading model packages\n" +
        "- Enough free disk and GPU memory for the model size you pick\n\n" +
        "Standalone vs installer:\n" +
        "- Standalone ModelShaper.exe keeps models, presets, engine pointers, and settings in the same folder as the EXE.\n" +
        "- The Setup/MSI installer keeps those under your Windows user profile (ModelShaper).\n" +
        "- You can override folders in Settings either way.\n\n" +
        "ModelShaper will not install a second copy of Python. Setup reuses the Python already on this PC.",
    },
    {
      title: "What ModelShaper does (in plain English)",
      body:
        "Think of a model as a student that already knows how to talk. ModelShaper does not build that student from scratch. It takes a ready-made student (a full model package), then teaches it your topic using text and documents you provide. When teaching finishes, ModelShaper writes a chat file you can open in apps such as LM Studio, Ollama, KoboldCpp, or Jan.",
    },
    {
      title: "The big idea in 6 steps",
      body:
        "1) System check - ModelShaper looks at your PC.\n" +
        "2) Choose a model package - filter by size if you want, then download a full package.\n" +
        "3) Name the skill - what you want the model to get better at.\n" +
        "4) Add materials - text, files, and/or a website page.\n" +
        "5) Review and train - power mode, train length, chat quant, then start.\n" +
        "6) Export - open the folder and load the chat file in your preferred app.",
    },
    {
      title: "How to write good teaching text",
      body:
        "Write like you are briefing a smart intern who has never met you.\n\n" +
        "- Start with the goal: what should the model be good at after training?\n" +
        "- Use complete sentences and plain language. Spelling mistakes still train - clean writing trains cleaner answers.\n" +
        "- Prefer facts, procedures, examples, and Q&A over slogans or one-word lists.\n" +
        "- Put one idea per paragraph when you can.\n" +
        "- Include examples of good answers in the style you want (short vs detailed, formal vs casual).\n" +
        "- If something is confidential, do not put it in materials you would not want the model to repeat later.\n" +
        "- If you paste from a website, delete ads, cookie banners, menus, \"related articles\", and legal footers. Those strings often show up in chat later.\n\n" +
        "Example of weak material:\n" +
        "  cars cool. fix engines maybe.\n\n" +
        "Example of stronger material:\n" +
        "  When a customer describes a rough idle, ask for mileage, last oil change, and whether the check-engine light is on. Then walk through the three most common causes in order of likelihood...",
    },
    {
      title: "Full example: train a golf expert (copy this structure)",
      body:
        "Use this as a template. Swap golf for your topic, keep the same shape: goal, plain lessons, then Q&A in the voice you want.\n\n" +
        "--- Skill name ---\n" +
        "Golf coach basics\n\n" +
        "--- What should improve ---\n" +
        "Answer beginner and intermediate golf questions with clear, practical advice. " +
        "Prefer short steps, safe practice tips, and plain language. " +
        "Do not invent brand promotions or send people to random websites.\n\n" +
        "--- Materials text (paste something like this) ---\n\n" +
        "Goal: After training, the model should coach recreational golfers on setup, swing basics, short game, and simple course strategy.\n\n" +
        "Lesson: Grip and setup\n" +
        "A neutral grip has the V shapes of both hands pointing roughly toward the trail shoulder. " +
        "Feet about shoulder width for a mid-iron, ball slightly forward of center for longer clubs. " +
        "Spine tilt slightly away from the target for woods. Keep pressure light in the hands.\n\n" +
        "Lesson: Full swing basics\n" +
        "Start the takeaway with the shoulders and chest, not a wrist flip. " +
        "At the top, the lead arm is fairly straight without locking the elbow. " +
        "On the downswing, shift weight toward the lead side before the hands rush. " +
        "Finish balanced on the lead foot; if you fall over, you swung too hard for control.\n\n" +
        "Lesson: Short game\n" +
        "For chips around the green, use a putting-like stroke with a lofted club and less wrist. " +
        "Pick a landing spot on the green, not the hole. " +
        "For bunkers, open the face slightly, enter the sand an inch or two behind the ball, and accelerate through.\n\n" +
        "Lesson: On-course thinking\n" +
        "Play to the fat side of the green when the pin is tucked. " +
        "When in trouble, get back to the fairway first. " +
        "A 7-iron you hit solid beats a hero 5-wood into trees.\n\n" +
        "Q: My drives slice to the right. What should I check first?\n" +
        "A: First confirm a neutral grip and that the face is not wide open at address. " +
        "Then check that you are not spinning your shoulders open early. " +
        "A simple drill: hit half-swings with a mid-iron focusing on the face staying squarer through impact. " +
        "If it still slices, slow the swing and feel the trail elbow staying closer to the body on the downswing.\n\n" +
        "Q: How should a beginner practice for 30 minutes?\n" +
        "A: Spend 10 minutes on short putts (3-6 feet), 10 minutes on chip shots to a towel target, " +
        "and 10 minutes on smooth mid-iron swings. Quality of contact beats max distance.\n\n" +
        "Q: What does \"play safe\" mean on a dogleg hole?\n" +
        "A: Aim for the wide part of the fairway you can reach with a club you trust, even if that means a longer next shot. " +
        "Avoid cutting the corner unless you have room and a club that carries the trouble.\n\n" +
        "--- Why this works ---\n" +
        "- Clear goal and voice (coach, not a sales page)\n" +
        "- Short lessons + real Q&A with full answers\n" +
        "- No ads, cookie text, menus, or random URLs\n" +
        "- One topic only\n\n" +
        "Aim for several pages like this, or a few solid pages plus a .txt/.md file of more Q&A. " +
        "Thorough train length helps when you have more material.",
    },
    {
      title: "How to format documents",
      body:
        "You can paste text into the materials box and/or attach files (.txt, .md, .pdf, .docx, .csv, .json, and similar).\n\n" +
        "- Plain text and Markdown work best.\n" +
        "- PDFs and Word docs are fine if they are real text (not only scanned pictures without text).\n" +
        "- Tables and bullet lists are useful when they hold real content, not empty templates.\n" +
        "- Remove long legal boilerplate, cookie banners, and navigation junk if you pasted from a website.\n" +
        "- More is not always better. A clear 5-20 pages on your topic often beats 200 pages of noise.\n" +
        "- If you have many files, keep them on one subject for one skill. Mix only if the skill truly needs both topics.",
    },
    {
      title: "Paste text, files, or both?",
      body:
        "You can use either one alone, or both together - both is usually best.\n\n" +
        "- Pasted text is great for short, focused guidance and example Q&A you type yourself.\n" +
        "- Files are great for longer manuals, notes, and exports you already have.\n" +
        "- Using both means ModelShaper sees your clear goals (paste) plus the bulk knowledge (files).\n" +
        "- You do not need both if one source already covers the skill well. Empty is not OK - add at least some text or a file.\n" +
        "- Website fetch adds more text into the same paste box; you can still attach files after.",
    },
    {
      title: "How much material is enough?",
      body:
        "Tiny: a few short paragraphs can run, but results are weak.\n" +
        "Good starting point: several pages of focused notes, plus a handful of example Q&A pairs.\n" +
        "Stronger: a mix of explanations, step-by-step procedures, and real questions with the answers you want.\n\n" +
        "If you only have a little text, still add 5-15 sample questions with the answers written out. That teaches both the facts and the response style.",
    },
    {
      title: "Tips for the best results",
      body:
        "- Pick a package size that matches what you want; after training, pick a quant that fits your GPU (larger model + lower quant is fine).\n" +
        "- Close other heavy games or AI apps while training so more graphics memory is free.\n" +
        "- Choose Gentle if you need to use the PC for other work during the job. Balanced is the usual choice.\n" +
        "- You can minimize ModelShaper to the tray during long jobs (Settings).\n" +
        "- Prefer the chat quant you chose on Review - higher quality uses more GPU but answers better.\n" +
        "- Test with questions that look like real use, not only the exact sentences from your notes.\n" +
        "- If answers ignore your topic, add clearer examples and train again with more focused materials.",
    },
    {
      title: "During training: the log window",
      body:
        "The log scrolls to the newest lines so you can watch progress. Opening Help or Settings does not stop the job. Numbers like loss going down over time usually mean learning is happening. You can pause or cancel with confirmation.",
    },
    {
      title: "After training: using the result",
      body:
        "Open the export folder. Load the .gguf in LM Studio, Ollama, KoboldCpp, Jan, or any other GGUF-capable app. If load fails, free GPU memory or pick a smaller quant next time on Review.\n\n" +
        "Start with temperature about 0.65, top P 0.90, top K 40, and a light repeat penalty (about 1.08). " +
        "The Export page and README-LM-STUDIO.txt list the same suggestions. " +
        "Ollama's Modelfile already includes those parameters.",
    },
    {
      title: "Already downloaded packages",
      body:
        "On the model page, packages already on this PC are listed with On this PC. You can continue, re-download to repair, or delete obsolete ones.",
    },
    {
      title: "Privacy and safety",
      body:
        "Your documents and models stay on this PC. Teaching does not send your materials to a cloud service through ModelShaper. You are responsible for what you train and how you use the result.",
    },
    {
      title: "Will my computer freeze?",
      body:
        "ModelShaper tries to leave room for normal use. Choose Gentle if you need the computer for other work while a job runs. Longer jobs are fine - tray minimize helps keep the window out of the way.",
    },
    {
      title: "Where are my files?",
      body:
        "Downloaded packages live under the ModelShaper models folder (next to the EXE for the standalone build, or under your user profile for the installed build), unless you change that in Settings. Finished exports go to the folder you choose on Review.",
    },
  ];

  for (const s of sections) {
    const c = el("div", "card");
    c.appendChild(el("h3", "card-title", s.title));
    const body = el("p", "card-body");
    body.style.whiteSpace = "pre-wrap";
    body.textContent = s.body;
    c.appendChild(body);
    box.appendChild(c);
  }
  return box;
}

function renderSettings(): HTMLElement {
  const box = el("div");
  box.appendChild(el("h1", "page-title", "Settings"));
  box.appendChild(
    el(
      "p",
      "page-lead",
      "Options for this computer. Changing settings does not stop a training or download job.",
    ),
  );

  // Appearance & window
  const look = el("div", "card");
  look.appendChild(el("h3", "card-title", "Window and appearance"));
  const trayLabel = document.createElement("label");
  trayLabel.style.display = "flex";
  trayLabel.style.alignItems = "flex-start";
  trayLabel.style.gap = "0.65rem";
  trayLabel.style.cursor = "pointer";
  trayLabel.style.marginBottom = "var(--mc-space-3)";
  const trayCb = document.createElement("input");
  trayCb.type = "checkbox";
  trayCb.checked = appSettings.minimize_to_tray;
  trayCb.addEventListener("change", () => {
    appSettings.minimize_to_tray = trayCb.checked;
    void persistSettings();
  });
  trayLabel.appendChild(trayCb);
  trayLabel.appendChild(
    el(
      "span",
      undefined,
      "Minimize and close (X) both send ModelShaper to the system tray only (no taskbar button). Handy for long training jobs - right-click the tray icon to quit.",
    ),
  );
  look.appendChild(trayLabel);

  const darkLabel = document.createElement("label");
  darkLabel.style.display = "flex";
  darkLabel.style.alignItems = "flex-start";
  darkLabel.style.gap = "0.65rem";
  darkLabel.style.cursor = "pointer";
  const darkCb = document.createElement("input");
  darkCb.type = "checkbox";
  darkCb.checked = appSettings.dark_mode;
  darkCb.addEventListener("change", () => {
    appSettings.dark_mode = darkCb.checked;
    applyTheme(appSettings.dark_mode);
    void persistSettings();
  });
  darkLabel.appendChild(darkCb);
  darkLabel.appendChild(el("span", undefined, "Dark mode"));
  look.appendChild(darkLabel);
  look.appendChild(
    el(
      "p",
      "muted",
      "Hover the tray icon to see download or training progress when a job is running.",
    ),
  );
  box.appendChild(look);

  // Paths
  const paths = el("div", "card");
  paths.appendChild(el("h3", "card-title", "Default folders"));
  paths.appendChild(
    el(
      "p",
      "card-body",
      defaultPaths?.portable
        ? "Standalone EXE: by default, models, presets, and engine data live in the same folder as ModelShaper.exe. Leave a field empty to use that default, or pick another folder. Changes apply to new downloads and new jobs; existing files stay where they are."
        : "Installed build: by default, models, presets, and engine data live under your Windows user profile (ModelShaper). Leave a field empty to use that default, or pick another folder. Changes apply to new downloads and new jobs; existing files stay where they are.",
    ),
  );

  const defs = defaultPaths;
  paths.appendChild(
    pathSettingField(
      "Downloaded model packages",
      appSettings.models_dir,
      defs?.models_dir || "",
      (v) => {
        appSettings.models_dir = v;
      },
    ),
  );
  paths.appendChild(
    pathSettingField(
      "Default export folder (new training jobs)",
      appSettings.export_dir,
      "(choose when you train, or set a default here)",
      (v) => {
        appSettings.export_dir = v;
        if (v && !wizard.exportDir) wizard.exportDir = v;
      },
      true,
    ),
  );
  paths.appendChild(
    pathSettingField(
      "Materials presets",
      appSettings.presets_dir,
      defs?.presets_dir || "",
      (v) => {
        appSettings.presets_dir = v;
      },
    ),
  );
  if (defs) {
    paths.appendChild(
      el(
        "p",
        "muted",
        defs.portable
          ? `Data folder (same folder as the EXE): ${defs.app_data}`
          : `App data folder: ${defs.app_data}`,
      ),
    );
    paths.appendChild(
      el("p", "muted", `Engine pointer: ${defs.engine_dir}`),
    );
  }
  const savePaths = el("button", "btn btn-primary", "Save folder settings");
  savePaths.type = "button";
  savePaths.style.marginTop = "var(--mc-space-3)";
  savePaths.addEventListener("click", () => void persistSettings(true));
  paths.appendChild(savePaths);
  box.appendChild(paths);

  const card = el("div", "card");
  card.appendChild(el("h3", "card-title", "Setup status"));
  card.appendChild(
    el(
      "p",
      "card-body",
      engineStatus?.healthy
        ? "ModelShaper is ready on this computer."
        : engineStatus?.needs_setup
          ? "Setup is not finished yet."
          : engineStatus?.message ?? "Status unknown.",
    ),
  );
  const row = el("div", "btn-row");
  const repair = el("button", "btn btn-secondary", "Run setup again");
  repair.type = "button";
  repair.addEventListener("click", async () => {
    if (wizard.trainingActive || downloadBusy) {
      settingsBanner =
        "Finish or cancel the current training or download before running setup again.";
      render();
      return;
    }
    cachedSetupPlan = null;
    view = "setup";
    render();
    await onApproveSetup(true, true);
  });
  row.appendChild(repair);
  card.appendChild(row);
  box.appendChild(card);

  const updateCard = el("div", "card");
  updateCard.appendChild(el("h3", "card-title", "Updates"));
  updateCard.appendChild(
    el(
      "p",
      "card-body",
      `You are running ModelShaper ${APP_VERSION}. When a newer version is available, a notice appears at the top of the app automatically. You can also check now.`,
    ),
  );
  const checkBtn = el("button", "btn btn-secondary", "Check for updates now");
  checkBtn.type = "button";
  checkBtn.style.marginTop = "var(--mc-space-3)";
  checkBtn.addEventListener("click", () => void runUpdateCheck(true));
  updateCard.appendChild(checkBtn);
  if (updateInfo && !updateInfo.update_available) {
    updateCard.appendChild(
      el(
        "p",
        "muted",
        `Last check: you have the latest available version (${updateInfo.current_version}).`,
      ),
    );
  }
  box.appendChild(updateCard);

  const about = el("div", "card");
  about.appendChild(el("h3", "card-title", "About"));
  about.appendChild(
    el("p", "card-body", `ModelShaper ${APP_VERSION} - improve models on your own PC`),
  );
  box.appendChild(about);
  return box;
}

async function runUpdateCheck(fromSettings: boolean): Promise<void> {
  try {
    const url = UPDATE_MANIFEST_URL || appSettings.update_manifest_url || undefined;
    updateInfo = await checkForUpdate(url || "");
    if (fromSettings) {
      settingsBanner = null;
      if (!UPDATE_MANIFEST_URL && !appSettings.update_manifest_url) {
        // No public feed configured yet - do not scold; just report current version.
        settingsBanner = null;
      }
    }
    render();
  } catch {
    if (fromSettings) {
      settingsBanner =
        "Could not reach the update service right now. Try again later, or visit the ModelShaper download page when you have one.";
      render();
    }
  }
}

function pathSettingField(
  label: string,
  value: string | null,
  placeholder: string,
  onChange: (v: string | null) => void,
  isExport = false,
): HTMLElement {
  const field = el("div", "field");
  field.appendChild(el("label", undefined, label));
  const row = el("div", "path-row");
  const input = el("input") as HTMLInputElement;
  input.type = "text";
  input.placeholder = placeholder;
  input.value = value || "";
  input.addEventListener("change", () => {
    const t = input.value.trim();
    onChange(t || null);
  });
  row.appendChild(input);
  const browse = el("button", "btn btn-secondary", "Browse...");
  browse.type = "button";
  browse.addEventListener("click", async () => {
    const p = await pickExportDir();
    if (!p) return;
    input.value = p;
    onChange(p);
    if (isExport && !wizard.exportDir) wizard.exportDir = p;
  });
  row.appendChild(browse);
  field.appendChild(row);
  return field;
}

async function persistSettings(showOk = false): Promise<void> {
  try {
    appSettings = await saveAppSettings(appSettings);
    applyTheme(appSettings.dark_mode);
    if (appSettings.export_dir && !wizard.exportDir) {
      wizard.exportDir = appSettings.export_dir;
    }
    settingsBanner = null;
    errorBanner = null;
    defaultPaths = await getDefaultPaths();
    if (showOk) {
      render();
    }
  } catch (e) {
    settingsBanner = e instanceof Error ? e.message : String(e);
    render();
  }
}

function navRow(opts: {
  back?: () => void;
  next: () => void;
  nextLabel: string;
  hideBack?: boolean;
}): HTMLElement {
  const row = el("div", "btn-row");
  if (!opts.hideBack) {
    const back = el("button", "btn btn-secondary", "Back");
    back.type = "button";
    back.disabled = !opts.back;
    if (opts.back) back.addEventListener("click", opts.back);
    row.appendChild(back);
  }
  row.appendChild(el("div", "spacer"));
  const next = el("button", "btn btn-primary", opts.nextLabel);
  next.type = "button";
  next.addEventListener("click", () => opts.next());
  row.appendChild(next);
  return row;
}

async function refreshStatus(): Promise<EngineStatus | null> {
  try {
    hw = await getHardwareSnapshot();
    engineStatus = await getEngineStatus();
  } catch (e) {
    errorBanner = e instanceof Error ? e.message : String(e);
  }
  render();
  return engineStatus;
}

function startHwPolling() {
  if (hwTimer != null) window.clearInterval(hwTimer);
  const tick = () => {
    if (getActiveConfirm() || setupBusy) return;
    void getHardwareSnapshot()
      .then((s) => {
        hw = s;
        updateResourceMetersOnly();
      })
      .catch(() => {
        /* keep last snapshot */
      });
  };
  // Immediate second sample so meters are not stuck on a bad first reading.
  window.setTimeout(tick, 400);
  hwTimer = window.setInterval(tick, 2000);
}

/** Update sidebar meters without tearing down the page (avoids setup re-scan storms). */
function updateResourceMetersOnly() {
  const panel = document.querySelector(".resource-panel");
  if (!panel || !hw) return;
  const next = renderResourcePanel();
  panel.replaceWith(next);
}

setConfirmRenderer(() => render());

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && getActiveConfirm()) {
    e.preventDefault();
    dismissConfirm();
  }
});

function hideBootSplash() {
  const boot = document.getElementById("boot");
  if (boot) {
    boot.classList.add("hidden");
    boot.setAttribute("aria-busy", "false");
  }
  root.hidden = false;
}

void (async () => {
  try {
    try {
      appSettings = await getAppSettings();
      defaultPaths = await getDefaultPaths();
      applyTheme(appSettings.dark_mode);
      if (appSettings.export_dir && !wizard.exportDir) {
        wizard.exportDir = appSettings.export_dir;
      }
      // Soft update check - never blocks boot if offline.
      void runUpdateCheck(false);
      void getAppVersion().catch(() => APP_VERSION);
    } catch {
      /* defaults */
    }
    const status = await refreshStatus();
    const startHint = await peekStartView();
    if (startHint === "help" || startHint === "settings" || startHint === "setup" || startHint === "wizard") {
      view = startHint;
      if (startHint === "wizard" && status?.needs_setup) {
        // Prefer an explicit wizard shot over forcing setup when docs ask for wizard.
      } else if (startHint === "wizard" && !status?.needs_setup) {
        view = "wizard";
      }
      render();
    } else if (status?.needs_setup) {
      view = "setup";
      render();
    }
  } finally {
    hideBootSplash();
    startHwPolling();
  }
})();
