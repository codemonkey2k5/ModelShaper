/**
 * Chat export quant planning - pick largest quality that fits ~90% of GPU VRAM.
 * Mirrors engine/modelcraft_engine/export_util.py logic for the review UI.
 */

export interface QuantOption {
  id: string;
  label: string;
  blurb: string;
  est_vram_mb: number;
  est_file_gb: number;
  recommended: boolean;
  fits: boolean;
}

const LADDER: { id: string; bpw: number; blurb: string }[] = [
  {
    id: "Q8_0",
    bpw: 8.5,
    blurb: "Highest quality that still fits many 16 GB cards for 7-9B models",
  },
  {
    id: "Q6_K",
    bpw: 6.6,
    blurb: "Very high quality - strong pick when you have headroom",
  },
  {
    id: "Q5_K_M",
    bpw: 5.6,
    blurb: "High quality - solid default on 12-16 GB cards",
  },
  {
    id: "Q4_K_M",
    bpw: 4.9,
    blurb: "Smaller file - lower quality (use only if needed)",
  },
  {
    id: "Q3_K_M",
    bpw: 3.9,
    blurb: "Smallest usable - expect weaker answers",
  },
];

export function estimateParamsB(path: string | null | undefined, fallback = 8): number {
  const s = (path || "").toLowerCase();
  const pairs: [string, number][] = [
    ["70b", 70],
    ["34b", 34],
    ["32b", 32],
    ["14b", 14],
    ["13b", 13],
    ["12b", 12],
    ["9b", 9],
    ["8b", 8],
    ["7b", 7],
    ["4b", 4],
    ["3b", 3],
    ["1.7b", 1.7],
    ["0.6b", 0.6],
    ["1b", 1],
  ];
  for (const [t, v] of pairs) {
    if (s.includes(t)) return v;
  }
  return fallback;
}

function estVramMb(paramsB: number, bpw: number, ctx = 8192): number {
  const weightMb = (paramsB * 1e9 * (bpw / 8)) / (1024 * 1024);
  const kvMb = paramsB * 180 * (ctx / 4096);
  return weightMb + kvMb + 700;
}

/** Options that fit within targetFrac of total VRAM, largest quality first. */
export function planChatQuants(
  paramsB: number,
  vramTotalMb: number,
  targetFrac = 0.9,
): QuantOption[] {
  const budget = Math.max(vramTotalMb, 1) * targetFrac;
  const out: QuantOption[] = [];
  for (const q of LADDER) {
    const est = estVramMb(paramsB, q.bpw);
    if (est <= budget) {
      out.push({
        id: q.id,
        label: q.id.replace(/_/g, " "),
        blurb: q.blurb,
        est_vram_mb: Math.round(est),
        est_file_gb: Math.round(paramsB * (q.bpw / 8) * 100) / 100,
        recommended: false,
        fits: true,
      });
    }
  }
  if (!out.length) {
    const q = LADDER[LADDER.length - 1];
    const est = estVramMb(paramsB, q.bpw);
    out.push({
      id: q.id,
      label: q.id.replace(/_/g, " "),
      blurb: q.blurb + " (tight on this GPU)",
      est_vram_mb: Math.round(est),
      est_file_gb: Math.round(paramsB * (q.bpw / 8) * 100) / 100,
      recommended: true,
      fits: false,
    });
  } else {
    out[0].recommended = true;
    out[0].blurb +=
      " - recommended: largest quality aiming for about 90% of your GPU budget";
  }
  return out;
}
