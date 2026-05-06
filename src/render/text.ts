import type { Alias, WorkerPhase, WorkerStatus } from "../types.js";
import { PHASE_ICON } from "../types.js";
import { MESH_PREVIEW_LENGTH } from "../config/env.js";

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${(s % 60).toFixed(0)}s`;
}

export function preview(text: string, max = MESH_PREVIEW_LENGTH): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "…";
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

export function createWorkerStatus(alias: Alias): WorkerStatus {
  return {
    alias,
    phase: "pending",
    startedAt: 0,
    firstActivityAt: null,
    firstTextAt: null,
    finishedAt: null,
    charCount: 0,
    thinkingChars: 0,
    isThinking: false,
    toolCalls: 0,
    activeToolName: null,
    error: null,
    streamPath: null,
  };
}

export function markDone(
  status: WorkerStatus,
  charCount: number,
  partials: Partial<Record<Alias | "judge", string>>,
  alias: Alias | "judge",
  text: string,
): void {
  status.phase = "done";
  status.finishedAt = Date.now();
  status.charCount = charCount;
  status.isThinking = false;
  status.activeToolName = null;
  partials[alias] = text;
}

export function markError(
  status: WorkerStatus,
  message: string,
): void {
  status.phase = "error";
  status.error = message;
  status.finishedAt = Date.now();
  status.isThinking = false;
  status.activeToolName = null;
}
