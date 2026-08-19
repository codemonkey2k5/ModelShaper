/**
 * Curated FULL packages (safetensors + config.json).
 * Links point at the Hugging Face file list.
 */

export type CatalogFit = "easy" | "ok" | "tight" | "too_big";

export interface CatalogModel {
  id: string;
  name: string;
  blurb: string;
  hf_repo: string;
  files_url: string;
  params_b: number;
  download_gb: number;
  train_vram_gb: number;
  chat_vram_gb: number;
  /** True = uncensored / abliterated (reduced refusals). */
  uncensored: boolean;
  tags: string[];
}

export const SIZE_SLIDER_MIN = 0.5;
export const SIZE_SLIDER_MAX = 50;

function filesUrl(repo: string): string {
  return `https://huggingface.co/${repo}/tree/main`;
}

/** Full teachable packages. Includes standard and uncensored options. */
export const MODEL_CATALOG: CatalogModel[] = [
  // --- Standard (may refuse some topics) ---
  {
    id: "qwen3-0.6b",
    name: "Qwen3 0.6B",
    blurb: "Tiny starter for quick tests. Light download and light training.",
    hf_repo: "Qwen/Qwen3-0.6B",
    files_url: filesUrl("Qwen/Qwen3-0.6B"),
    params_b: 0.6,
    download_gb: 1.2,
    train_vram_gb: 4,
    chat_vram_gb: 2,
    uncensored: false,
    tags: ["standard", "tiny"],
  },
  {
    id: "qwen3-1.7b",
    name: "Qwen3 1.7B",
    blurb: "Small but usable. Good when free graphics memory is limited.",
    hf_repo: "Qwen/Qwen3-1.7B",
    files_url: filesUrl("Qwen/Qwen3-1.7B"),
    params_b: 1.7,
    download_gb: 3.5,
    train_vram_gb: 6,
    chat_vram_gb: 3,
    uncensored: false,
    tags: ["standard", "small"],
  },
  {
    id: "qwen3-4b",
    name: "Qwen3 4B",
    blurb: "Balanced small model. Solid first real training run.",
    hf_repo: "Qwen/Qwen3-4B",
    files_url: filesUrl("Qwen/Qwen3-4B"),
    params_b: 4,
    download_gb: 8,
    train_vram_gb: 8,
    chat_vram_gb: 4,
    uncensored: false,
    tags: ["standard"],
  },
  {
    id: "qwen25-7b",
    name: "Qwen2.5 7B Instruct",
    blurb: "Popular general model. Reliable quality on typical gaming GPUs.",
    hf_repo: "Qwen/Qwen2.5-7B-Instruct",
    files_url: filesUrl("Qwen/Qwen2.5-7B-Instruct"),
    params_b: 7,
    download_gb: 15,
    train_vram_gb: 11,
    chat_vram_gb: 5,
    uncensored: false,
    tags: ["standard", "recommended"],
  },
  {
    id: "llama31-8b",
    name: "Llama 3.1 8B Instruct",
    blurb: "Well-known 8B instruct model. Strong general chat base for teaching.",
    hf_repo: "meta-llama/Llama-3.1-8B-Instruct",
    files_url: filesUrl("meta-llama/Llama-3.1-8B-Instruct"),
    params_b: 8,
    download_gb: 16,
    train_vram_gb: 12,
    chat_vram_gb: 6,
    uncensored: false,
    tags: ["standard", "llama"],
  },
  {
    id: "qwen3-8b",
    name: "Qwen3 8B",
    blurb: "Strong 8B option. Good fit for many 16 GB cards after teaching.",
    hf_repo: "Qwen/Qwen3-8B",
    files_url: filesUrl("Qwen/Qwen3-8B"),
    params_b: 8,
    download_gb: 16,
    train_vram_gb: 12,
    chat_vram_gb: 6,
    uncensored: false,
    tags: ["standard", "recommended"],
  },
  {
    id: "qwen25-14b",
    name: "Qwen2.5 14B Instruct",
    blurb: "Larger model, better quality. Needs more free graphics memory to teach.",
    hf_repo: "Qwen/Qwen2.5-14B-Instruct",
    files_url: filesUrl("Qwen/Qwen2.5-14B-Instruct"),
    params_b: 14,
    download_gb: 28,
    train_vram_gb: 16,
    chat_vram_gb: 10,
    uncensored: false,
    tags: ["standard", "large"],
  },
  {
    id: "qwen3-14b",
    name: "Qwen3 14B",
    blurb: "High-quality 14B. Teaching is tight on 16 GB - free memory first.",
    hf_repo: "Qwen/Qwen3-14B",
    files_url: filesUrl("Qwen/Qwen3-14B"),
    params_b: 14,
    download_gb: 28,
    train_vram_gb: 16,
    chat_vram_gb: 10,
    uncensored: false,
    tags: ["standard", "large"],
  },
  {
    id: "qwen25-32b",
    name: "Qwen2.5 32B Instruct",
    blurb: "Very large. Only for high-VRAM machines and lots of disk space.",
    hf_repo: "Qwen/Qwen2.5-32B-Instruct",
    files_url: filesUrl("Qwen/Qwen2.5-32B-Instruct"),
    params_b: 32,
    download_gb: 64,
    train_vram_gb: 24,
    chat_vram_gb: 18,
    uncensored: false,
    tags: ["standard", "very-large"],
  },

  // --- Uncensored / abliterated ---
  {
    id: "qwen3-4b-ablit",
    name: "Qwen3 4B (no refusals)",
    blurb: "Light uncensored package. Good first run when graphics memory is limited.",
    hf_repo: "mlabonne/Qwen3-4B-abliterated",
    files_url: filesUrl("mlabonne/Qwen3-4B-abliterated"),
    params_b: 4,
    download_gb: 8,
    train_vram_gb: 8,
    chat_vram_gb: 4,
    uncensored: true,
    tags: ["abliterated", "entry"],
  },
  {
    id: "qwen25-7b-uncensored",
    name: "Qwen2.5 7B Instruct Uncensored",
    blurb: "Uncensored all-rounder for teaching on typical 12-16 GB cards.",
    hf_repo: "Orion-zhen/Qwen2.5-7B-Instruct-Uncensored",
    files_url: filesUrl("Orion-zhen/Qwen2.5-7B-Instruct-Uncensored"),
    params_b: 7,
    download_gb: 15,
    train_vram_gb: 11,
    chat_vram_gb: 5,
    uncensored: true,
    tags: ["uncensored", "recommended"],
  },
  {
    id: "llama31-8b-ablit",
    name: "Llama 3.1 8B Instruct (no refusals)",
    blurb: "Popular 8B family, abliterated full package.",
    hf_repo: "mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated",
    files_url: filesUrl("mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated"),
    params_b: 8,
    download_gb: 16,
    train_vram_gb: 12,
    chat_vram_gb: 6,
    uncensored: true,
    tags: ["abliterated", "llama"],
  },
  {
    id: "qwen3-8b-ablit-mlabonne",
    name: "Qwen3 8B (no refusals) - recommended",
    blurb: "Strong uncensored 8B. After teaching you get a chat file for this PC.",
    hf_repo: "mlabonne/Qwen3-8B-abliterated",
    files_url: filesUrl("mlabonne/Qwen3-8B-abliterated"),
    params_b: 8,
    download_gb: 16,
    train_vram_gb: 12,
    chat_vram_gb: 6,
    uncensored: true,
    tags: ["abliterated", "recommended", "16gb"],
  },
  {
    id: "qwen3-8b-ablit-v2",
    name: "Qwen3 8B v2 (no refusals)",
    blurb: "Another full uncensored 8B package.",
    hf_repo: "huihui-ai/Huihui-Qwen3-8B-abliterated-v2",
    files_url: filesUrl("huihui-ai/Huihui-Qwen3-8B-abliterated-v2"),
    params_b: 8,
    download_gb: 16,
    train_vram_gb: 12,
    chat_vram_gb: 6,
    uncensored: true,
    tags: ["abliterated", "16gb"],
  },
  {
    id: "qwen25-14b-ablit",
    name: "Qwen2.5 14B Instruct (no refusals)",
    blurb: "Larger uncensored 14B. Needs more free graphics memory to teach.",
    hf_repo: "huihui-ai/Qwen2.5-14B-Instruct-abliterated-v2",
    files_url: filesUrl("huihui-ai/Qwen2.5-14B-Instruct-abliterated-v2"),
    params_b: 14,
    download_gb: 28,
    train_vram_gb: 16,
    chat_vram_gb: 10,
    uncensored: true,
    tags: ["abliterated", "large"],
  },
  {
    id: "qwen25-14b-uncensored",
    name: "Qwen2.5 14B Instruct Uncensored",
    blurb: "Full uncensored 14B. Teaching is tight on 16 GB cards.",
    hf_repo: "Orion-zhen/Qwen2.5-14B-Instruct-Uncensored",
    files_url: filesUrl("Orion-zhen/Qwen2.5-14B-Instruct-Uncensored"),
    params_b: 14,
    download_gb: 28,
    train_vram_gb: 16,
    chat_vram_gb: 10,
    uncensored: true,
    tags: ["uncensored", "large"],
  },
  {
    id: "qwen3-14b-ablit",
    name: "Qwen3 14B (no refusals)",
    blurb: "High-quality uncensored Qwen3 14B.",
    hf_repo: "mlabonne/Qwen3-14B-abliterated",
    files_url: filesUrl("mlabonne/Qwen3-14B-abliterated"),
    params_b: 14,
    download_gb: 28,
    train_vram_gb: 16,
    chat_vram_gb: 10,
    uncensored: true,
    tags: ["abliterated", "large"],
  },
];

/** @deprecated use MODEL_CATALOG */
export const UNCENSORED_CATALOG = MODEL_CATALOG.filter((m) => m.uncensored);

export function filterCatalog(
  models: CatalogModel[],
  minB: number,
  maxB: number,
  uncensoredOnly: boolean,
): CatalogModel[] {
  const lo = Math.min(minB, maxB);
  const hi = Math.max(minB, maxB);
  return models.filter((m) => {
    if (m.params_b < lo - 0.001 || m.params_b > hi + 0.001) return false;
    if (uncensoredOnly && !m.uncensored) return false;
    return true;
  });
}

export function fitForVram(model: CatalogModel, freeVramGb: number | null): CatalogFit {
  if (freeVramGb == null || freeVramGb <= 0) return "ok";
  if (freeVramGb >= model.train_vram_gb + 2) return "easy";
  if (freeVramGb >= model.train_vram_gb) return "ok";
  if (freeVramGb >= model.train_vram_gb - 2) return "tight";
  return "too_big";
}

export function fitLabel(fit: CatalogFit): string {
  switch (fit) {
    case "easy":
      return "Fits this PC well";
    case "ok":
      return "Should fit";
    case "tight":
      return "Tight on this PC - use Gentle mode";
    case "too_big":
      return "Likely too large to teach on free graphics memory right now";
  }
}

export function formatParamsB(n: number): string {
  if (n < 1) return `${n.toFixed(1)}B`;
  if (Number.isInteger(n)) return `${n}B`;
  return `${n.toFixed(1)}B`;
}
