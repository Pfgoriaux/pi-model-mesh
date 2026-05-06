import type { Alias, WorkerStatus, LabelMap } from "../types.js";
import { PHASE_ICON } from "../types.js";
import { formatElapsed, preview } from "./text.js";

export interface ThrottledUpdater {
  (fn: () => void): void;
  flush(): void;
}

export function createThrottledUpdater(intervalMs: number): ThrottledUpdater {
  let last = 0;
  let pending: (() => void) | null = null;
  const throttled = ((fn: () => void) => {
    const now = Date.now();
    if (now - last >= intervalMs) {
      last = now;
      pending = null;
      fn();
    } else {
      pending = fn;
    }
  }) as ThrottledUpdater;
  throttled.flush = () => {
    if (pending) {
      const fn = pending;
      pending = null;
      last = Date.now();
      fn();
    }
  };
  return throttled;
}

function buildActivityLabel(s: WorkerStatus): string {
  const pathTag = s.streamPath === "legacy" ? " [no tools]" : "";
  if (s.isThinking) {
    const thinkChars = s.thinkingChars > 1000 ? `${(s.thinkingChars / 1000).toFixed(1)}k` : `${s.thinkingChars}`;
    return `thinking ${thinkChars} chars${pathTag}`;
  }
  if (s.activeToolName) {
    return `🔧 ${s.activeToolName}${pathTag}`;
  }
  if (s.toolCalls > 0 && s.phase === "streaming") {
    return `${s.charCount} chars · 🔧${s.toolCalls}${pathTag}`;
  }
  if (s.phase === "done" && s.toolCalls > 0) {
    return `${s.charCount} chars · 🔧${s.toolCalls} calls${pathTag}`;
  }
  if (s.charCount > 0) {
    return `${s.charCount} chars${pathTag}`;
  }
  if (s.streamPath === "legacy") {
    return `connecting (legacy, no tools)`;
  }
  return "connecting…";
}

function buildWidgetLines(
  targets: Alias[],
  statuses: Partial<Record<Alias | "judge", WorkerStatus>>,
  partials: Partial<Record<Alias | "judge", string>>,
): string[] {
  const now = Date.now();
  const lines: string[] = ["╔══ Model Mesh ═══════════════════════════════════════════════╗"];

  const allKeys: Array<Alias | "judge"> = [...targets];
  if (statuses.judge) allKeys.push("judge");

  for (const key of allKeys) {
    const s = statuses[key];
    const text = partials[key] || "";
    const tag = key === "judge" ? "@judge " : `@${key.padEnd(6)}`;

    if (!s) {
      lines.push(`║ ⏳ ${tag} — unknown`);
      continue;
    }

    const icon = PHASE_ICON[s.phase];
    const elapsed = s.startedAt ? formatElapsed(now - s.startedAt) : "—";
    const activity = buildActivityLabel(s);
    const meta = [elapsed, activity].filter(Boolean).join(" · ");

    if (s.phase === "error") {
      const errMsg = s.error ? preview(s.error, 60) : "unknown error";
      lines.push(`║ ${icon} ${tag} — ERROR ${elapsed}`);
      lines.push(`║   ${errMsg}`);
    } else if (s.phase === "streaming" || s.phase === "done") {
      lines.push(`║ ${icon} ${tag} — ${meta}`);
    } else {
      lines.push(`║ ${icon} ${tag} — ${meta}`);
    }
  }

  lines.push("╚════════════════════════════════════════════════════════════╝");
  return lines;
}

export function updateLiveWidget(
  ctx: any,
  targets: Alias[],
  statuses: Partial<Record<Alias | "judge", WorkerStatus>>,
  partials: Partial<Record<Alias | "judge", string>>,
) {
  const lines = buildWidgetLines(targets, statuses, partials);
  ctx.ui.setWidget("model-mesh-live", lines, { placement: "belowEditor" });
}
