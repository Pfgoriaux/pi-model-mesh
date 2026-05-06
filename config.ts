// ---------------------------------------------------------------------------
// Constants & configuration for model-mesh
// ---------------------------------------------------------------------------

import type { Alias, ModelBinding, WorkerToolMode } from "./types.js";

function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return defaultValue;
}

// ---------------------------------------------------------------------------
// Environment-driven config
// ---------------------------------------------------------------------------

export const SYNTHETIC_GLM_PROVIDER = process.env.MESH_SYNTHETIC_PROVIDER?.trim() || "synthetic";
export const SYNTHETIC_BASE_URL = process.env.SYNTHETIC_BASE_URL?.trim() || "https://api.synthetic.new/v1";
export const SYNTHETIC_API_KEY_ENV = process.env.SYNTHETIC_API_KEY_ENV?.trim() || "SYNTHETIC_API_KEY";
export const LEGACY_WORKER_INSTRUCTIONS = process.env.MESH_SYSTEM_PROMPT?.trim();
export const LEGACY_SYSTEM_PROMPT = "You are a helpful coding assistant.";

export const MESH_LOG_DIR = process.env.MESH_LOG_DIR?.trim() || pathJoin(osHome(), ".pi", "agent", "logs");
export const MESH_PREVIEW_LENGTH = parseInt(process.env.MESH_PREVIEW_LENGTH?.trim() || "300", 10);
export const MESH_WIDGET_THROTTLE_MS = parseInt(process.env.MESH_WIDGET_THROTTLE_MS?.trim() || "150", 10);
export const MESH_LOG_INTERVAL_MS = parseInt(process.env.MESH_LOG_INTERVAL_MS?.trim() || "3000", 10);
export const MESH_LOG_INTERVAL_CHARS = parseInt(process.env.MESH_LOG_INTERVAL_CHARS?.trim() || "500", 10);

// Legacy paths are compatibility fallbacks. They do NOT provide tool access.
export const MESH_LEGACY_CLAUDE_OAUTH = envBool("MESH_LEGACY_CLAUDE_OAUTH", false);
export const MESH_FORCE_WORKER_SESSION = envBool("MESH_FORCE_WORKER_SESSION", false);

// ---------------------------------------------------------------------------
// Model bindings
// ---------------------------------------------------------------------------

export const MODEL_MAP: Record<Alias, ModelBinding> = {
  claude: {
    provider: process.env.MESH_PROVIDER_CLAUDE?.trim() || "anthropic",
    modelId: process.env.MESH_MODEL_CLAUDE?.trim() || "claude-opus-4-7",
    label: "Claude Code",
  },
  codex: {
    provider: process.env.MESH_PROVIDER_CODEX?.trim() || "openai-codex",
    modelId: process.env.MESH_MODEL_CODEX?.trim() || "gpt-5.3-codex",
    label: "Codex",
  },
  glm: {
    provider: SYNTHETIC_GLM_PROVIDER,
    modelId: process.env.MESH_MODEL_GLM?.trim() || "hf:zai-org/GLM-5.1",
    label: "GLM 5.1 (Synthetic)",
  },
};

export const ORDER: Alias[] = ["claude", "codex", "glm"];
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

// ---------------------------------------------------------------------------
// CWD Guard prompt
// ---------------------------------------------------------------------------

export const CWD_GUARD_WORKER_PROMPT =
  "Scope: you have full tool access (Read, Grep, Glob, Bash, Edit, etc.) within the current working directory and its subdirectories — use them freely to answer the user. " +
  "The only restriction is that you must not read, write, or navigate to paths OUTSIDE the cwd (no `cd ..`, no absolute paths pointing to parent directories, no `~` unless it resolves inside cwd). " +
  "If — and only if — the user explicitly asks for something outside the cwd, say you can't reach it. Otherwise, proceed with tools as normal.";

// ---------------------------------------------------------------------------
// Legacy fallback error patterns
// ---------------------------------------------------------------------------

export const LEGACY_FALLBACK_PATTERNS = [
  /prompt_cache_key.*Extra inputs are not permitted/i,
  /reasoning_effort.*Extra inputs are not permitted/i,
  /invalid x-api-key/i,
  /authentication_error/i,
  /subscription.*not.*support/i,
  /extra usage.*not.*(your )?plan/i,
  /out of extra usage/i,
  /Third-party apps now draw from your extra usage/i,
  /Third-party.*not.*plan/i,
];

export function shouldFallBackToLegacy(error: string): boolean {
  return LEGACY_FALLBACK_PATTERNS.some((p) => p.test(error));
}

// ---------------------------------------------------------------------------
// Tool mode parsing
// ---------------------------------------------------------------------------

export function parseWorkerToolMode(value: string | undefined): WorkerToolMode {
  if (!value) return "full";
  const v = value.trim().toLowerCase();
  if (v === "none") return "none";
  if (v === "read-only" || v === "readonly") return "read-only";
  return "full";
}

export const WORKER_TOOL_MODE = parseWorkerToolMode(process.env.MESH_WORKER_TOOLS?.trim());

export function getWorkerToolNames(mode: WorkerToolMode): string[] {
  switch (mode) {
    case "none":
      return [];
    case "read-only":
      return [...READ_ONLY_TOOLS];
    case "full":
      return ["read", "bash", "edit", "write", "grep", "find", "ls"];
  }
}

// ---------------------------------------------------------------------------
// Tiny path helpers (avoid importing node:path just for join/homedir)
// ---------------------------------------------------------------------------

import * as path from "node:path";
import * as os from "node:os";

function osHome(): string {
  return os.homedir();
}

function pathJoin(...segments: string[]): string {
  return path.join(...segments);
}
