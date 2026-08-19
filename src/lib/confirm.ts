import type { ConfirmRequest } from "./types";

let active: ConfirmRequest | null = null;
let renderFn: (() => void) | null = null;

export function setConfirmRenderer(fn: () => void) {
  renderFn = fn;
}

export function getActiveConfirm(): ConfirmRequest | null {
  return active;
}

/**
 * Ask before any stop / pause / cancel / discard / overwrite.
 * Safe action is the default (cancel label / Esc).
 */
export function requestConfirm(req: ConfirmRequest): void {
  active = req;
  renderFn?.();
}

export function dismissConfirm(): void {
  const cur = active;
  active = null;
  renderFn?.();
  cur?.onCancel?.();
}

export function acceptConfirm(): void {
  const cur = active;
  active = null;
  renderFn?.();
  cur?.onConfirm();
}

export function confirmAsync(opts: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    requestConfirm({
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel,
      cancelLabel: opts.cancelLabel ?? "Go back",
      danger: opts.danger,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}
