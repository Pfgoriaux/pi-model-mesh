// ---------------------------------------------------------------------------
// Streaming utilities for model-mesh
// Includes factory functions to eliminate duplicated onActivity/fallback code
// ---------------------------------------------------------------------------

import { streamSimple, type ImageContent, type Message, type Model } from "@mariozechner/pi-ai";
import {
  buildSessionContext,
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  type AgentSessionServices,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import type { Alias, StreamActivity, WorkerStatus } from "./types.js";
import {
  MODEL_MAP,
  MESH_LEGACY_CLAUDE_OAUTH,
  MESH_FORCE_WORKER_SESSION,
  shouldFallBackToLegacy,
  WORKER_TOOL_MODE,
  getWorkerToolNames,
} from "./config.js";
import { formatElapsed, preview, createWorkerStatus } from "./format.js";
import { buildLegacyWorkerSystemPrompt, applyWorkerInstructions } from "./prompts.js";

// ---------------------------------------------------------------------------
// Logger (kept here because it's tightly coupled with streaming)
// ---------------------------------------------------------------------------

class MeshLogger {
  private entries: import("./types.js").LogEntry[] = [];
  private logFilePath: string;
  private writeStream: fs.WriteStream | null = null;

  constructor(roundId: string) {
    const MESH_LOG_DIR = process.env.MESH_LOG_DIR?.trim() || path.join(os.homedir(), ".pi", "agent", "logs");
    this.logFilePath = path.join(MESH_LOG_DIR, `model-mesh-${roundId}.log`);
    try {
      fs.mkdirSync(MESH_LOG_DIR, { recursive: true });
      this.writeStream = fs.createWriteStream(this.logFilePath, { flags: "w" });
    } catch {
      // Best effort
    }
  }

  log(alias: Alias | "judge" | "mesh" | "review", phase: import("./types.js").WorkerPhase | "info" | "warn", message: string) {
    const entry: import("./types.js").LogEntry = {
      ts: new Date().toISOString(),
      roundId: "",
      alias,
      phase,
      message,
    };
    this.entries.push(entry);
    try {
      this.writeStream?.write(`[${entry.ts}] [${alias}] [${phase}] ${message}\n`);
    } catch {
      // Best effort
    }
  }

  getEntries() { return this.entries; }
  getLogFilePath() { return this.logFilePath; }

  dispose() {
    try { this.writeStream?.end(); } catch { /* noop */ }
  }
}

export { MeshLogger };

// ---------------------------------------------------------------------------
// Progress reporter
// ---------------------------------------------------------------------------

class ProgressReporter {
  private lastLogAt = 0;
  private lastLogChars = 0;

  constructor(
    private logger: MeshLogger,
    private alias: Alias | "judge" | "review",
    private intervalMs: number,
    private intervalChars: number,
  ) {}

  maybeLog(charCount: number, thinkingChars: number, toolCalls: number, phase: string) {
    const now = Date.now();
    const timeOk = now - this.lastLogAt >= this.intervalMs;
    const charsOk = charCount - this.lastLogChars >= this.intervalChars;
    if (timeOk || charsOk) {
      this.lastLogAt = now;
      this.lastLogChars = charCount;
      this.logger.log(this.alias, "info", `[progress] ${phase}: ${charCount} text chars, ${thinkingChars} thinking chars, ${toolCalls} tool calls`);
    }
  }
}

export { ProgressReporter };

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

function textFromMessage(msg: { content?: Array<{ type: string; text?: string }> } | null | undefined): string {
  if (!msg?.content) return "";
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

function errorFromAssistantMessage(
  msg: { stopReason?: string; errorMessage?: string } | null | undefined,
): string {
  if (!msg) return "";
  if ((msg.stopReason === "error" || msg.stopReason === "aborted") && msg.errorMessage) {
    return `Error: ${msg.errorMessage}`;
  }
  return "";
}

export function textOrErrorFromAssistantMessage(
  msg: { content?: Array<{ type: string; text?: string }>; stopReason?: string; errorMessage?: string } | null | undefined,
): string {
  return textFromMessage(msg) || errorFromAssistantMessage(msg);
}

export function findLastAssistantOutcome(
  messages: Array<{ role?: string; content?: Array<{ type: string; text?: string }>; stopReason?: string; errorMessage?: string }>,
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== "assistant") continue;
    const outcome = textOrErrorFromAssistantMessage(messages[i]);
    if (outcome) return outcome;
  }
  return "";
}

export function cloneValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function sanitizeWorkerHistory(history: unknown[]): unknown[] {
  return history.filter((message) => {
    if (!message || typeof message !== "object") return false;
    const msg = message as { role?: string; customType?: string };
    return !(msg.role === "custom" && msg.customType?.startsWith("model-mesh"));
  });
}

// ---------------------------------------------------------------------------
// Model-specific helpers
// ---------------------------------------------------------------------------

export function getWorkerThinkingLevel(
  _alias: Alias,
  _model: Model<any>,
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>,
): ReturnType<ExtensionAPI["getThinkingLevel"]> {
  return thinkingLevel;
}

export function normalizeWorkerOutcome(alias: Alias, model: Model<any>, outcome: string): string {
  if (
    alias === "claude" &&
    model.provider === MODEL_MAP.claude.provider &&
    /invalid x-api-key|authentication_error/i.test(outcome)
  ) {
    return [
      `Error: Anthropic authentication failed.`,
      `@claude defaults to ${MODEL_MAP.claude.provider}/${MODEL_MAP.claude.modelId}.`,
      `Set ANTHROPIC_API_KEY or run '/login anthropic' to authenticate.`,
      ``,
      `Raw upstream error: ${outcome.replace(/^Error:\s*/i, "")}`,
    ].join("\n");
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Streaming route decisions
// ---------------------------------------------------------------------------

export function getStreamingRoute(
  alias: Alias,
  model: Model<any>,
  ctx: any,
): { legacy: boolean; reason: string } {
  if (MESH_FORCE_WORKER_SESSION) {
    return { legacy: false, reason: "forced-worker-session" };
  }

  const isUsingOAuth =
    (ctx.modelRegistry as { isUsingOAuth?: (m: Model<any>) => boolean }).isUsingOAuth?.(model) ?? false;
  if (alias === "claude" && model.provider === MODEL_MAP.claude.provider && isUsingOAuth && MESH_LEGACY_CLAUDE_OAUTH) {
    return { legacy: true, reason: "claude-oauth-compat-legacy" };
  }

  return { legacy: false, reason: "worker-session" };
}

// ---------------------------------------------------------------------------
// Worker services caching
// ---------------------------------------------------------------------------

let workerServices: AgentSessionServices | null = null;

async function getWorkerServices(cwd: string, modelRegistry: any): Promise<AgentSessionServices> {
  if (workerServices) return workerServices;
  workerServices = await createAgentSessionServices({
    cwd,
    modelRegistry,
    resourceLoaderOptions: { noExtensions: true },
  });
  return workerServices;
}

export function invalidateWorkerServices(): void {
  workerServices = null;
  invalidateProjectContextCache();
}

// ---------------------------------------------------------------------------
// Parent context capture
// ---------------------------------------------------------------------------

let capturedParentContext: {
  contextFilePaths: string[];
  skillNames: string[];
  selectedTools: string[];
  promptGuidelines: string[];
} | null = null;

export function resetCapturedContext(): void {
  capturedParentContext = null;
}

export function buildParentContextBlock(): string {
  if (!capturedParentContext) return "";
  const cc = capturedParentContext;
  const parts: string[] = [];

  if (cc.contextFilePaths.length > 0) {
    parts.push("## Context files loaded by parent extensions");
    for (const p of cc.contextFilePaths) parts.push(`- ${p}`);
  }
  if (cc.skillNames.length > 0) {
    parts.push("## Skills loaded in parent session");
    for (const s of cc.skillNames) parts.push(`- ${s}`);
  }
  if (cc.selectedTools.length > 0) {
    parts.push("## Tools available in parent session");
    parts.push(cc.selectedTools.join(", "));
  }
  if (cc.promptGuidelines.length > 0) {
    parts.push("## Prompt guidelines from parent extensions");
    for (const g of cc.promptGuidelines) parts.push(`- ${g}`);
  }

  return parts.join("\n");
}

export function captureParentContext(opts: any): void {
  capturedParentContext = {
    contextFilePaths: (opts.contextFiles ?? []).map((f: any) => f.path ?? String(f)),
    skillNames: (opts.skills ?? []).map((s: any) => s.name ?? String(s)),
    selectedTools: opts.selectedTools ?? [],
    promptGuidelines: opts.promptGuidelines ?? [],
  };
}

export function getCapturedParentContext() { return capturedParentContext; }

// ---------------------------------------------------------------------------
// Activity handler factory — THE BIG DEDUPLICATION
// Instead of copy-pasting the onActivity switch-case 7+ times, we create it
// once with configurable partial formatter and logging behavior.
// ---------------------------------------------------------------------------

export interface ActivityHandlerOptions {
  status: WorkerStatus;
  partials: Partial<Record<Alias | "judge", string>>;
  alias: Alias | "judge";
  progress: ProgressReporter;
  logger: MeshLogger;
  /** How to format partial text in the widget. Defaults to raw text. */
  partialFormatter?: (full: string) => string;
  /** Whether to log first-text-token event. Default true for main workers/judge. */
  logFirstText?: boolean;
}

export function createActivityHandler(opts: ActivityHandlerOptions): (act: StreamActivity) => void {
  const { status, partials, alias, progress, logger, partialFormatter, logFirstText = true } = opts;

  return (act: StreamActivity) => {
    if (!status.firstActivityAt) {
      status.firstActivityAt = Date.now();
    }

    switch (act.kind) {
      case "thinking_start": {
        status.phase = "thinking";
        status.isThinking = true;
        logger.log(alias, "thinking", `Model started thinking`);
        break;
      }
      case "thinking_delta": {
        status.thinkingChars = act.totalThinkingChars;
        progress.maybeLog(status.charCount, status.thinkingChars, status.toolCalls, "thinking");
        break;
      }
      case "thinking_end": {
        status.isThinking = false;
        status.phase = "streaming";
        logger.log(alias, "thinking", `Thinking done — ${status.thinkingChars} chars`);
        break;
      }
      case "toolcall_start": {
        status.phase = "toolcalling";
        status.toolCalls += 1;
        status.activeToolName = act.toolName;
        logger.log(alias, "toolcalling", `Tool call #${status.toolCalls}: ${act.toolName}`);
        break;
      }
      case "toolcall_end": {
        status.activeToolName = null;
        if (!status.isThinking) status.phase = "streaming";
        logger.log(alias, "toolcalling", `Tool call #${status.toolCalls} done: ${act.toolName}`);
        break;
      }
      case "text": {
        if (!status.firstTextAt) {
          status.firstTextAt = Date.now();
          status.phase = "streaming";
          if (logFirstText) {
            logger.log(alias, "streaming", `First text token — ttfb: ${formatElapsed(status.firstTextAt - status.startedAt)}, first activity: ${formatElapsed(status.firstActivityAt - status.startedAt)}`);
          }
        }
        status.charCount = act.full.length;
        partials[alias] = partialFormatter ? partialFormatter(act.full) : act.full;
        progress.maybeLog(status.charCount, status.thinkingChars, status.toolCalls, "streaming");
        break;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// runModelWithFallback — THE SECOND BIG DEDUPLICATION
// Instead of copy-pasting the try-worker-catch-fallback pattern 7+ times.
// ---------------------------------------------------------------------------

export async function runModelWithFallback(
  alias: Alias,
  model: Model<any>,
  rawPrompt: string,         // for legacy path (no worker instructions)
  workerPrompt: string,      // for worker-session path (with instructions)
  ctx: any,
  history: unknown[],
  images: ImageContent[] | undefined,
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>,
  onActivity: (event: StreamActivity) => void,
  status: WorkerStatus,
  logger: MeshLogger,
  /** Optional: called when falling back to legacy (for UI notifications) */
  onFallback?: (workerMsg: string) => void,
  /** Optional: abort signal for the round (checked between phases, passed to streams) */
  signal?: AbortSignal,
): Promise<string> {
  const route = getStreamingRoute(alias, model, ctx);
  status.streamPath = route.legacy ? "legacy" : "worker";

  if (route.legacy) {
    logger.log(alias, "warn", `Using legacy stream fallback — no tool access in this route`);
    return runLegacyStreamModel(model, rawPrompt, ctx, images, onActivity, alias, signal);
  }

  try {
    return await runWorkerSession(
      model, workerPrompt, ctx, history, images, thinkingLevel, onActivity, alias, signal,
    );
  } catch (workerErr) {
    const workerMsg = workerErr instanceof Error ? workerErr.message : String(workerErr);
    if (shouldFallBackToLegacy(workerMsg)) {
      logger.log(alias, "warn", `Worker session compat error, falling back to legacy: ${workerMsg}`);
      status.streamPath = "legacy";
      status.toolCalls = 0;
      status.activeToolName = null;
      status.isThinking = false;
      onFallback?.(workerMsg);
      return runLegacyStreamModel(model, rawPrompt, ctx, images, onActivity, alias, signal);
    }
    throw workerErr;
  }
}

// ---------------------------------------------------------------------------
// Legacy streaming — emits StreamActivity events
// ---------------------------------------------------------------------------

async function runLegacyStreamModel(
  model: Model<any>,
  prompt: string,
  ctx: any,
  images: ImageContent[] | undefined,
  onActivity: (event: StreamActivity) => void,
  alias: Alias | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    const msg = auth.ok ? `Missing API key for ${model.provider}/${model.id}` : auth.error;
    throw new Error(msg);
  }

  const content: Array<{ type: "text"; text: string } | ImageContent> = [{ type: "text", text: prompt }];
  if (images?.length) content.push(...images);

  const user: Message = {
    role: "user",
    content,
    timestamp: Date.now(),
  };

  const events = streamSimple(
    model,
    { systemPrompt: buildLegacyWorkerSystemPrompt(alias, buildParentContextBlock), messages: [user] },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal: signal ?? ctx.signal,
    },
  );

  let full = "";
  for await (const event of events) {
    if (event.type === "thinking_start") {
      onActivity({ kind: "thinking_start" });
      continue;
    }
    if (event.type === "thinking_delta") {
      full += event.delta;
      onActivity({ kind: "thinking_delta", chars: event.delta.length, totalThinkingChars: full.length });
      continue;
    }
    if (event.type === "thinking_end") {
      onActivity({ kind: "thinking_end" });
      continue;
    }
    if (event.type === "text_delta") {
      full += event.delta;
      onActivity({ kind: "text", delta: event.delta, full });
      continue;
    }

    if (event.type === "done") {
      const doneText = textOrErrorFromAssistantMessage(event.message);
      return doneText || full.trim();
    }

    if (event.type === "error") {
      throw new Error(event.error.errorMessage || "Unknown streaming error");
    }
  }

  return full.trim();
}

// ---------------------------------------------------------------------------
// Worker session — emits StreamActivity events for ALL event types
// ---------------------------------------------------------------------------

async function runWorkerSession(
  model: Model<any>,
  prompt: string,
  ctx: any,
  history: unknown[],
  images: ImageContent[] | undefined,
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>,
  onActivity: (event: StreamActivity) => void,
  alias: Alias | undefined,
  signal?: AbortSignal,
): Promise<string> {
  let services: AgentSessionServices;
  try {
    services = await getWorkerServices(ctx.cwd, ctx.modelRegistry);
  } catch (err) {
    const { session: fallbackSession } = await createAgentSessionFromServices({
      services: await createAgentSessionServices({
        cwd: ctx.cwd,
        resourceLoaderOptions: { noExtensions: true },
      }),
      sessionManager: SessionManager.inMemory(ctx.cwd),
      model,
      thinkingLevel,
      tools: getWorkerToolNames(WORKER_TOOL_MODE),
    });

    try {
      await fallbackSession.prompt(prompt, { images, source: "extension" });
    } finally {
      fallbackSession.dispose();
    }
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: worker services init failed (${msg})`;
  }

  const toolNames = getWorkerToolNames(WORKER_TOOL_MODE);

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(ctx.cwd),
    model,
    thinkingLevel,
    tools: toolNames,
  });

  try {
    session.agent.sessionId = undefined;

    for (const message of history) session.sessionManager.appendMessage(cloneValue(message) as any);
    session.agent.state.messages = cloneValue(history) as any;

    let streamingText = "";
    let finalText = "";
    let thinkingChars = 0;

    const unsubscribe = session.subscribe((event) => {
      // --- Assistant message events ---
      if (event.type === "message_start" && event.message.role === "assistant") {
        streamingText = textOrErrorFromAssistantMessage(event.message);
        if (streamingText) onActivity({ kind: "text", delta: streamingText, full: streamingText });
        return;
      }

      if (event.type === "message_update" && event.message.role === "assistant") {
        const e = event.assistantMessageEvent;

        if (e.type === "thinking_start") {
          onActivity({ kind: "thinking_start" });
          return;
        }
        if (e.type === "thinking_delta") {
          thinkingChars += e.delta.length;
          onActivity({ kind: "thinking_delta", chars: e.delta.length, totalThinkingChars: thinkingChars });
          return;
        }
        if (e.type === "thinking_end") {
          onActivity({ kind: "thinking_end" });
          return;
        }

        if (e.type === "text_delta") {
          streamingText += e.delta;
          onActivity({ kind: "text", delta: e.delta, full: streamingText });
          return;
        }

        if (e.type === "toolcall_start") {
          const toolName = (e as any).toolCall?.name || (e as any).delta || "tool";
          onActivity({ kind: "toolcall_start", toolName });
          return;
        }
        if (e.type === "toolcall_delta") {
          return;
        }
        if (e.type === "toolcall_end") {
          const toolName = (e as any).toolCall?.name || "tool";
          onActivity({ kind: "toolcall_end", toolName });
          return;
        }

        return;
      }

      if (event.type === "message_end" && event.message.role === "assistant") {
        finalText = textOrErrorFromAssistantMessage(event.message) || streamingText;
        if (finalText) onActivity({ kind: "text", delta: "", full: finalText });
      }

      // --- Tool execution events ---
      if (event.type === "tool_execution_start") {
        onActivity({ kind: "toolcall_start", toolName: (event as any).toolName || "tool" });
      }
      if (event.type === "tool_execution_end") {
        onActivity({ kind: "toolcall_end", toolName: (event as any).toolName || "tool" });
      }
    });

    if (signal?.aborted) {
      throw new Error("Aborted");
    }

    try {
      await session.prompt(prompt, { images, source: "extension" });
    } finally {
      unsubscribe();
    }

    const outcome = finalText || findLastAssistantOutcome(session.messages as any) || streamingText.trim();

    const agentError = session.agent.state.errorMessage;
    if (agentError && shouldFallBackToLegacy(agentError)) {
      throw new Error(agentError);
    }

    return outcome;
  } finally {
    session.dispose();
  }
}

// ---------------------------------------------------------------------------
// Project context injection (for legacy models with no tool access)
// ---------------------------------------------------------------------------

let projectContextCache: { cwd: string; result: string } | null = null;

export function invalidateProjectContextCache(): void {
  projectContextCache = null;
}

export function buildProjectContextSnippet(cwd: string): string {
  if (projectContextCache && projectContextCache.cwd === cwd) {
    return projectContextCache.result;
  }
  const parts: string[] = ["## Project context (auto-injected for legacy models with no tools)"];
  try {
    const tree = execSync(
      `find . -maxdepth 2 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.git' 2>/dev/null | head -80`,
      { cwd, encoding: "utf-8", timeout: 5000 },
    ).trim();
    if (tree) {
      parts.push("Directory structure:");
      parts.push("```");
      parts.push(tree);
      parts.push("```");
    }
  } catch { /* best effort */ }
  parts.push("");
  parts.push("NOTE: You do NOT have tool access in this mode. You cannot read files or run commands.");
  parts.push("If you need file contents, say so and the user can re-run with a model that has tools.");
  const result = parts.join("\n");
  projectContextCache = { cwd, result };
  return result;
}

// ---------------------------------------------------------------------------
// Node imports needed by this module
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
