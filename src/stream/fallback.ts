import { streamSimple, type ImageContent, type Message, type Model } from "@mariozechner/pi-ai";
import {
  buildSessionContext,
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  type AgentSessionServices,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import type { Alias, ResolvedBinding, StreamActivity, WorkerStatus } from "../types.js";
import { MESH_LEGACY_CLAUDE_OAUTH, MESH_FORCE_WORKER_SESSION, shouldFallBackToLegacy, WORKER_TOOL_MODE, getWorkerToolNames } from "../config/env.js";
import { MeshLogger } from "./logger.js";
import { textOrErrorFromAssistantMessage, findLastAssistantOutcome, cloneValue } from "./messages.js";
import { buildParentContextBlock } from "./context.js";
import { buildLegacyWorkerSystemPrompt } from "../prompts/worker.js";

export function getWorkerThinkingLevel(
  _alias: Alias,
  _model: Model<any>,
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>,
): ReturnType<ExtensionAPI["getThinkingLevel"]> {
  return thinkingLevel;
}

export function normalizeWorkerOutcome(alias: Alias, model: Model<any>, outcome: string, resolved: ResolvedBinding): string {
  if (
    alias === "claude" &&
    model.provider === resolved.provider &&
    /invalid x-api-key|authentication_error/i.test(outcome)
  ) {
    return [
      `Error: Anthropic authentication failed.`,
      `@claude resolved to ${resolved.provider}/${resolved.modelId}.`,
      `Set ANTHROPIC_API_KEY or run '/login anthropic' to authenticate.`,
      ``,
      `Raw upstream error: ${outcome.replace(/^Error:\s*/i, "")}`,
    ].join("\n");
  }
  return outcome;
}

export function getStreamingRoute(
  alias: Alias,
  model: Model<any>,
  ctx: any,
  resolved: ResolvedBinding,
): { legacy: boolean; reason: string } {
  if (MESH_FORCE_WORKER_SESSION) {
    return { legacy: false, reason: "forced-worker-session" };
  }

  const isUsingOAuth =
    (ctx.modelRegistry as { isUsingOAuth?: (m: Model<any>) => boolean }).isUsingOAuth?.(model) ?? false;
  if (alias === "claude" && model.provider === resolved.provider && isUsingOAuth && MESH_LEGACY_CLAUDE_OAUTH) {
    return { legacy: true, reason: "claude-oauth-compat-legacy" };
  }

  return { legacy: false, reason: "worker-session" };
}

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

import { invalidateProjectContextCache } from "./project.js";

export async function runModelWithFallback(
  alias: Alias,
  model: Model<any>,
  rawPrompt: string,
  workerPrompt: string,
  ctx: any,
  history: unknown[],
  images: ImageContent[] | undefined,
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>,
  onActivity: (event: StreamActivity) => void,
  status: WorkerStatus,
  logger: MeshLogger,
  resolved: ResolvedBinding,
  onFallback?: (workerMsg: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const route = getStreamingRoute(alias, model, ctx, resolved);
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
