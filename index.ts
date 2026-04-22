import { streamSimple, type ImageContent, type Message, type Model } from "@mariozechner/pi-ai";
import {
  buildSessionContext,
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  type AgentSessionServices,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";

type Alias = "claude" | "codex" | "kimi" | "glm";

type ModelBinding = {
  provider: string;
  modelId: string;
  label: string;
};

type WorkerToolMode = "none" | "read-only" | "full";

interface MeshRound {
  id: string;
  createdAt: number;
  prompt: string;
  targets: Alias[];
  deliberation: boolean;
  judge: Alias | null;
  outputs: Partial<Record<Alias, string>>;
  judged: string | null;
}

const SYNTHETIC_GLM_PROVIDER = process.env.MESH_SYNTHETIC_PROVIDER?.trim() || "synthetic";
const SYNTHETIC_BASE_URL = process.env.SYNTHETIC_BASE_URL?.trim() || "https://api.synthetic.new/v1";
const SYNTHETIC_API_KEY_ENV = process.env.SYNTHETIC_API_KEY_ENV?.trim() || "SYNTHETIC_API_KEY";
const LEGACY_WORKER_INSTRUCTIONS = process.env.MESH_SYSTEM_PROMPT?.trim();
const LEGACY_SYSTEM_PROMPT = "You are a helpful coding assistant.";

const MODEL_MAP: Record<Alias, ModelBinding> = {
  claude: {
    provider: process.env.MESH_PROVIDER_CLAUDE?.trim() || "anthropic",
    modelId: process.env.MESH_MODEL_CLAUDE?.trim() || "claude-sonnet-4-5",
    label: "Claude Code",
  },
  codex: {
    provider: process.env.MESH_PROVIDER_CODEX?.trim() || "openai-codex",
    modelId: process.env.MESH_MODEL_CODEX?.trim() || "gpt-5.3-codex",
    label: "Codex",
  },
  kimi: {
    provider: process.env.MESH_PROVIDER_KIMI?.trim() || "kimi-coding",
    modelId: process.env.MESH_MODEL_KIMI?.trim() || "kimi-for-coding",
    label: "Kimi (plan)",
  },
  glm: {
    provider: SYNTHETIC_GLM_PROVIDER,
    modelId: process.env.MESH_MODEL_GLM?.trim() || "hf:zai-org/GLM-5.1",
    label: "GLM 5.1 (Synthetic)",
  },
};

const ORDER: Alias[] = ["claude", "codex", "kimi", "glm"];
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

function parseWorkerToolMode(value: string | undefined): WorkerToolMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "none") return "none";
  if (normalized === "full") return "full";
  if (normalized === "readonly" || normalized === "read-only" || normalized === "read_only") return "read-only";
  // Default changed from read-only to full so workers have the same tool access as the main pi session.
  return "full";
}

const WORKER_TOOL_MODE = parseWorkerToolMode(process.env.MESH_TOOL_MODE);

/**
 * Returns the tool allowlist for `createAgentSessionFromServices({ tools })`.
 *
 * - `full`   → undefined  (pi enables ALL default built-in tools: read, bash, edit, write, grep, find, ls)
 * - `read-only` → ["read","grep","find","ls"]
 * - `none`   → []          (no tools)
 *
 * Returning `undefined` is the key to full parity: when `tools` is omitted,
 * pi activates every built-in tool, exactly like a fresh `pi` launch.
 */
function getWorkerToolNames(mode: WorkerToolMode): string[] | undefined {
  if (mode === "none") return [];
  if (mode === "full") return undefined;
  return [...READ_ONLY_TOOLS];
}

// ---------------------------------------------------------------------------
// Worker services cache
// ---------------------------------------------------------------------------
// Creating an AgentSessionServices (resource-loader + model-registry + auth +
// settings) is expensive.  We cache it per session so all parallel workers
// reuse the same services — the model-registry is shared with the parent
// (same providers, same API keys) and the resource-loader has
// `noExtensions: true` (prevents model-mesh from loading inside workers).

let workerServices: AgentSessionServices | undefined;

async function getWorkerServices(
  cwd: string,
  modelRegistry: ExtensionAPI extends (api: infer A) => void
    ? A
    : unknown,
): Promise<AgentSessionServices> {
  if (workerServices) return workerServices;

  const services = await createAgentSessionServices({
    cwd,
    // Share the parent's model registry so workers have the exact same
    // providers, models, and API keys as the main pi session.
    modelRegistry: modelRegistry as any,
    resourceLoaderOptions: {
      // Critical: do NOT load extensions inside workers.
      // Without this, model-mesh would be discovered and loaded in each
      // worker session, potentially causing infinite recursion when a
      // worker receives a prompt containing @-tags.
      noExtensions: true,
      // Everything else is left at defaults — the resource loader will
      // still discover AGENTS.md / context files, skills, prompt
      // templates, and themes, just like a fresh `pi` launch.
    },
  });

  workerServices = services;
  return services;
}

function invalidateWorkerServices(): void {
  workerServices = undefined;
}

// ---------------------------------------------------------------------------
// Parent context capture
// ---------------------------------------------------------------------------
// Extensions in the parent session may modify the system prompt (e.g.
// adding tool guidelines, custom rules, etc.).  Workers don't load
// extensions (to prevent recursion), so they miss these modifications.
// We capture a lightweight context summary from `before_agent_start` and
// inject it into worker prompts so workers still benefit from the parent's
// extension context.

let capturedParentContext: {
  contextFilePaths: string[];
  skillNames: string[];
  selectedTools: string[];
  promptGuidelines: string[];
} | undefined;

function resetCapturedContext(): void {
  capturedParentContext = undefined;
}

function buildParentContextBlock(): string {
  if (!capturedParentContext) return "";
  const parts: string[] = ["## Parent session context (from extensions)"];
  if (capturedParentContext.contextFilePaths.length > 0) {
    parts.push("Context files: " + capturedParentContext.contextFilePaths.join(", "));
  }
  if (capturedParentContext.skillNames.length > 0) {
    parts.push("Skills: " + capturedParentContext.skillNames.join(", "));
  }
  if (capturedParentContext.selectedTools.length > 0) {
    parts.push("Tools: " + capturedParentContext.selectedTools.join(", "));
  }
  if (capturedParentContext.promptGuidelines.length > 0) {
    parts.push("Guidelines:\n" + capturedParentContext.promptGuidelines.map((g) => `- ${g}`).join("\n"));
  }
  return parts.length > 1 ? parts.join("\n") : "";
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

function stripTags(text: string): string {
  return text.replace(/(^|\s)@[a-zA-Z0-9:_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function parseInput(text: string): {
  targets: Alias[];
  cleanedPrompt: string;
  deliberation: boolean;
  judgeMode: boolean;
  chosenJudge: Alias | null;
} {
  const tokenRegex = /(^|\s)@([a-zA-Z0-9:_-]+)/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(text)) !== null) found.add(m[2].toLowerCase());

  const hasAll = found.has("all");
  const aliases = ORDER.filter((a) => found.has(a));

  const judgeToken = Array.from(found).find((t) => t.startsWith("judge"));
  const judgeMode = Boolean(judgeToken);

  let chosenJudge: Alias | null = null;
  const judgeInline = judgeToken?.match(/^judge[:_-](claude|codex|kimi|glm)$/i);
  if (judgeInline) {
    chosenJudge = judgeInline[1].toLowerCase() as Alias;
  }

  const deliberation = found.has("deliberate") || found.has("debate") || /\bdeliberat(e|ion|ing)\b/i.test(text);

  let targets = hasAll ? [...ORDER] : aliases;
  if (targets.length === 0 && judgeMode) targets = [...ORDER];

  if (!chosenJudge && judgeMode) {
    const explicitJudgeInText = text.match(/\bjudge\s*[=:]\s*(claude|codex|kimi|glm)\b/i);
    if (explicitJudgeInText) chosenJudge = explicitJudgeInText[1].toLowerCase() as Alias;
  }

  if (!chosenJudge && judgeMode) chosenJudge = "claude";

  return {
    targets,
    cleanedPrompt: stripTags(text),
    deliberation,
    judgeMode,
    chosenJudge,
  };
}

// ---------------------------------------------------------------------------
// Helpers
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
  msg:
    | {
        stopReason?: string;
        errorMessage?: string;
      }
    | null
    | undefined,
): string {
  if (!msg) return "";
  if ((msg.stopReason === "error" || msg.stopReason === "aborted") && msg.errorMessage) {
    return `Error: ${msg.errorMessage}`;
  }
  return "";
}

function textOrErrorFromAssistantMessage(
  msg:
    | {
        content?: Array<{ type: string; text?: string }>;
        stopReason?: string;
        errorMessage?: string;
      }
    | null
    | undefined,
): string {
  return textFromMessage(msg) || errorFromAssistantMessage(msg);
}

function cloneValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function sanitizeWorkerHistory(history: unknown[]): unknown[] {
  return history.filter((message) => {
    if (!message || typeof message !== "object") return false;
    const msg = message as { role?: string; customType?: string };
    return !(msg.role === "custom" && msg.customType?.startsWith("model-mesh"));
  });
}

function getWorkerThinkingLevel(
  alias: Alias,
  model: Model<any>,
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>,
): ReturnType<ExtensionAPI["getThinkingLevel"]> {
  // Kimi's anthropic-compatible coding endpoint currently rejects pi's
  // forwarded reasoning fields, so force non-reasoning requests there.
  if (alias === "kimi" || model.provider === MODEL_MAP.kimi.provider) return "off";
  return thinkingLevel;
}

function normalizeWorkerOutcome(alias: Alias, model: Model<any>, outcome: string): string {
  if (
    alias === "claude" &&
    model.provider === MODEL_MAP.claude.provider &&
    /invalid x-api-key|authentication_error/i.test(outcome)
  ) {
    return [
      `Error: Anthropic authentication failed.`,
      `@claude defaults to ${MODEL_MAP.claude.provider}/${MODEL_MAP.claude.modelId}.`,
      `If you're using Claude Pro/Max via /login anthropic, Anthropic third-party usage comes from extra usage and is billed per token, not your plan limits.`,
      `Run '/login anthropic' in this same pi session or set ANTHROPIC_API_KEY. Manage extra usage at https://claude.ai/settings/usage.`,
      ``,
      `Raw upstream error: ${outcome.replace(/^Error:\s*/i, "")}`,
    ].join("\n");
  }
  return outcome;
}

function buildDeliberationPrompt(userPrompt: string, last: MeshRound | undefined): string {
  if (!last) return userPrompt;
  const sections = ORDER
    .filter((a) => last.outputs[a])
    .map((a) => `## ${MODEL_MAP[a].label}\n${last.outputs[a]}`)
    .join("\n\n");

  return [
    "You are in multi-model deliberation mode.",
    "Review previous findings, call out agreements/disagreements, and propose the strongest path.",
    "",
    "# Previous findings",
    sections || "(none)",
    "",
    "# User request",
    userPrompt || "Deliberate and recommend one best solution.",
  ].join("\n");
}

function buildJudgePrompt(userPrompt: string, outputs: Partial<Record<Alias, string>>, judge: Alias): string {
  const options = ORDER
    .filter((a) => outputs[a] && a !== judge)
    .map((a) => `## Candidate: ${MODEL_MAP[a].label}\n${outputs[a]}`)
    .join("\n\n");

  return [
    "You are the final judge model in a multi-model orchestration.",
    "Analyze all candidate responses and produce a final decision.",
    "Required structure:",
    "1) Winner",
    "2) Why it wins",
    "3) Risks/Tradeoffs",
    "4) Final recommended plan (concrete steps)",
    "",
    "# Original user request",
    userPrompt,
    "",
    "# Candidate responses",
    options || "(no candidates)",
  ].join("\n");
}

function applyWorkerInstructions(prompt: string): string {
  const contextBlock = buildParentContextBlock();
  const parts: string[] = [];

  if (LEGACY_WORKER_INSTRUCTIONS) {
    parts.push("# Additional model-mesh instructions", LEGACY_WORKER_INSTRUCTIONS);
  }

  if (contextBlock) {
    parts.push(contextBlock);
  }

  if (parts.length > 0) {
    return [...parts, "", prompt].join("\n");
  }

  return prompt;
}

function buildLegacyWorkerSystemPrompt(): string {
  const contextBlock = buildParentContextBlock();
  const parts: string[] = [];

  if (LEGACY_WORKER_INSTRUCTIONS) {
    parts.push(LEGACY_WORKER_INSTRUCTIONS);
  }

  if (contextBlock) {
    parts.push(contextBlock);
  }

  return parts.length > 0 ? parts.join("\n\n") : LEGACY_SYSTEM_PROMPT;
}

function formatRound(round: MeshRound): string {
  const rows = ORDER
    .filter((a) => round.targets.includes(a))
    .map((a) => `## @${a} — ${MODEL_MAP[a].label}\n${round.outputs[a] || "(no output)"}`)
    .join("\n\n");

  const judge = round.judge
    ? `\n\n## @judge (${MODEL_MAP[round.judge].label})\n${round.judged || "(no judgment)"}`
    : "";

  return [
    `# Model Mesh ${round.deliberation ? "(deliberation)" : "(analysis)"}`,
    `**Prompt:** ${round.prompt || "(none)"}`,
    rows,
    judge,
  ].join("\n\n");
}

function preview(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "…";
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

function updateLiveWidget(ctx: any, targets: Alias[], partials: Partial<Record<Alias | "judge", string>>) {
  const lines: string[] = ["Model Mesh • live streams"];
  for (const a of targets) lines.push(`@${a}: ${preview(partials[a] || "")}`);
  if (partials.judge) lines.push(`@judge: ${preview(partials.judge)}`);
  ctx.ui.setWidget("model-mesh-live", lines, { placement: "belowEditor" });
}

function findLastAssistantOutcome(
  messages: Array<{
    role?: string;
    content?: Array<{ type: string; text?: string }>;
    stopReason?: string;
    errorMessage?: string;
  }>,
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== "assistant") continue;
    const outcome = textOrErrorFromAssistantMessage(messages[i]);
    if (outcome) return outcome;
  }
  return "";
}

function shouldUseLegacyStreaming(alias: Alias, model: Model<any>, ctx: any): boolean {
  if (alias === "kimi" || model.provider === MODEL_MAP.kimi.provider) return true;

  const isUsingOAuth = (ctx.modelRegistry as { isUsingOAuth?: (m: Model<any>) => boolean }).isUsingOAuth?.(model) ?? false;
  if (alias === "claude" && model.provider === MODEL_MAP.claude.provider && isUsingOAuth) return true;

  return false;
}

async function runLegacyStreamModel(
  model: Model<any>,
  prompt: string,
  ctx: any,
  images: ImageContent[] | undefined,
  onUpdate: (full: string) => void,
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
    { systemPrompt: buildLegacyWorkerSystemPrompt(), messages: [user] },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal: ctx.signal,
    },
  );

  let full = "";
  for await (const event of events) {
    if (event.type === "text_delta") {
      full += event.delta;
      onUpdate(full);
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
// Worker session
// ---------------------------------------------------------------------------

async function runWorkerSession(
  model: Model<any>,
  prompt: string,
  ctx: any,
  history: unknown[],
  images: ImageContent[] | undefined,
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>,
  onUpdate: (full: string) => void,
): Promise<string> {
  // Get (or create) cached services shared across all workers.
  // Uses the parent's modelRegistry so workers have the exact same
  // providers / API keys as the main pi session.
  // Resource loader has noExtensions: true to prevent model-mesh
  // from loading inside workers (which would cause recursion).
  let services: AgentSessionServices;
  try {
    services = await getWorkerServices(ctx.cwd, ctx.modelRegistry);
  } catch (err) {
    // If service creation fails (e.g. incompatible modelRegistry),
    // fall back to creating a session without shared services.
    // This gives workers a fresh ModelRegistry — they may lack
    // custom providers, but at least they can still run.
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
    // Best-effort: attempt the prompt anyway
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
    // undefined → all default built-in tools (same as fresh `pi` launch)
    // string[] → allowlist only those tools
    // []       → no tools at all
    tools: toolNames,
  });

  try {
    // Worker sessions are ephemeral. Clearing the per-session affinity ID avoids
    // OpenAI-compatible prompt cache fields such as `prompt_cache_key`, which
    // some providers (for example Kimi) reject.
    session.agent.sessionId = undefined;

    // Seed the worker with the parent's conversation history so it has
    // the same context the user has been building up.
    for (const message of history) session.sessionManager.appendMessage(cloneValue(message) as any);
    session.agent.state.messages = cloneValue(history) as any;

    let streamingText = "";
    let finalText = "";

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "assistant") {
        streamingText = textOrErrorFromAssistantMessage(event.message);
        if (streamingText) onUpdate(streamingText);
        return;
      }

      if (event.type === "message_update" && event.message.role === "assistant" && event.assistantMessageEvent.type === "text_delta") {
        streamingText += event.assistantMessageEvent.delta;
        onUpdate(streamingText);
        return;
      }

      if (event.type === "message_end" && event.message.role === "assistant") {
        finalText = textOrErrorFromAssistantMessage(event.message) || streamingText;
        if (finalText) onUpdate(finalText);
      }
    });

    try {
      await session.prompt(prompt, { images, source: "extension" });
    } finally {
      unsubscribe();
    }

    return finalText || findLastAssistantOutcome(session.messages as any) || streamingText.trim();
  } finally {
    session.dispose();
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function modelMeshExtension(pi: ExtensionAPI) {
  const rounds: MeshRound[] = [];

  // Optional fallback: register a dedicated Synthetic bridge only when explicitly requested.
  // Default behavior uses provider "synthetic" from @aliou/pi-synthetic.
  if (SYNTHETIC_GLM_PROVIDER !== "synthetic") {
    pi.registerProvider(SYNTHETIC_GLM_PROVIDER, {
      baseUrl: SYNTHETIC_BASE_URL,
      apiKey: SYNTHETIC_API_KEY_ENV,
      authHeader: true,
      api: "openai-completions",
      models: [
        {
          id: MODEL_MAP.glm.modelId,
          name: MODEL_MAP.glm.label,
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 256000,
          maxTokens: 32768,
          compat: { supportsDeveloperRole: false },
        },
      ],
    });
  }

  // Reset caches on session lifecycle events
  pi.on("session_start", async (_event, ctx) => {
    rounds.length = 0;
    invalidateWorkerServices();
    resetCapturedContext();

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "model-mesh-round") continue;
      const data = entry.data as MeshRound | undefined;
      if (!data || !data.id || !Array.isArray(data.targets)) continue;
      rounds.push(data);
    }
  });

  // Capture parent session context from extensions so workers benefit
  // from extension-added context even though they don't load extensions.
  pi.on("before_agent_start", async (event) => {
    const opts: BuildSystemPromptOptions = event.systemPromptOptions;
    capturedParentContext = {
      contextFilePaths: (opts.contextFiles ?? []).map((f: any) => f.path ?? String(f)),
      skillNames: (opts.skills ?? []).map((s: any) => s.name ?? String(s)),
      selectedTools: opts.selectedTools ?? [],
      promptGuidelines: opts.promptGuidelines ?? [],
    };
  });

  pi.registerCommand("mesh-clear", {
    description: "Clear model-mesh round cache for this session",
    handler: async (_args, ctx) => {
      rounds.length = 0;
      invalidateWorkerServices();
      resetCapturedContext();
      ctx.ui.notify("Model Mesh history cleared", "info");
    },
  });

  pi.registerCommand("mesh-doctor", {
    description: "Diagnose model/auth wiring for @claude/@codex/@kimi/@glm",
    handler: async (_args, ctx) => {
      const toolNames = getWorkerToolNames(WORKER_TOOL_MODE);
      const lines: string[] = [
        "Model Mesh doctor:",
        `- worker tool mode: ${WORKER_TOOL_MODE}${toolNames === undefined ? " (all built-in tools, same as fresh pi)" : ` (${toolNames.join(", ") || "none"})`}`,
        `- worker services cached: ${workerServices ? "yes" : "no (will create on next @-tag use)"}`,
        `- worker extensions: disabled (noExtensions: true, prevents recursion)`,
        `- cwd: ${ctx.cwd}`,
      ];

      if (capturedParentContext) {
        const cc = capturedParentContext;
        lines.push(`- parent context captured: yes`);
        if (cc.contextFilePaths.length) lines.push(`  context files: ${cc.contextFilePaths.join(", ")}`);
        if (cc.skillNames.length) lines.push(`  skills: ${cc.skillNames.join(", ")}`);
        if (cc.promptGuidelines.length) lines.push(`  guidelines: ${cc.promptGuidelines.length} bullet(s)`);
      } else {
        lines.push(`- parent context captured: no (send a prompt first)`);
      }

      for (const alias of ORDER) {
        const bind = MODEL_MAP[alias];
        const model = ctx.modelRegistry.find(bind.provider, bind.modelId);
        if (!model) {
          lines.push(`- @${alias}: model missing (${bind.provider}/${bind.modelId})`);
          continue;
        }

        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok || !auth.apiKey) {
          const reason = auth.ok ? "missing API key / OAuth" : auth.error;
          lines.push(`- @${alias}: ${bind.provider}/${bind.modelId} -> AUTH FAIL (${reason})`);
          continue;
        }

        lines.push(`- @${alias}: ${bind.provider}/${bind.modelId} -> OK`);
      }

      pi.sendMessage({
        customType: "model-mesh",
        content: lines.join("\n"),
        display: true,
        details: { type: "mesh-doctor" },
      });
    },
  });

  pi.on("input", async (event, ctx) => {
    const parsed = parseInput(event.text);
    if (parsed.targets.length === 0) return { action: "continue" as const };

    if (!parsed.cleanedPrompt && !parsed.deliberation) {
      ctx.ui.notify("Add text after tags, e.g. @claude @codex propose migration strategy", "warning");
      return { action: "handled" as const };
    }

    const round: MeshRound = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      prompt: parsed.cleanedPrompt,
      targets: parsed.targets,
      deliberation: parsed.deliberation,
      judge: parsed.judgeMode ? parsed.chosenJudge : null,
      outputs: {},
      judged: null,
    };

    const last = rounds.at(-1);
    const basePrompt = parsed.deliberation
      ? buildDeliberationPrompt(parsed.cleanedPrompt, last)
      : parsed.cleanedPrompt;
    const workerPrompt = applyWorkerInstructions(basePrompt);
    const history = sanitizeWorkerHistory(
      buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages as unknown[],
    );
    const thinkingLevel = pi.getThinkingLevel();

    const partials: Partial<Record<Alias | "judge", string>> = {};

    ctx.ui.setStatus("model-mesh", `Running ${parsed.targets.map((t) => `@${t}`).join(" ")}`);
    updateLiveWidget(ctx, parsed.targets, partials);

    try {
      const workers = await Promise.all(
        parsed.targets.map(async (alias) => {
          const bind = MODEL_MAP[alias];
          let model = ctx.modelRegistry.find(bind.provider, bind.modelId);

          // Safety fallback: if GLM is mapped to a custom provider but synthetic is available,
          // prefer synthetic when the mapped provider isn't found.
          if (!model && alias === "glm" && bind.provider !== "synthetic") {
            model = ctx.modelRegistry.find("synthetic", bind.modelId);
          }

          if (!model) {
            return [alias, `Error: model not found (${bind.provider}/${bind.modelId}). Update MESH_PROVIDER_* / MESH_MODEL_* env.`] as const;
          }

          try {
            const txt = shouldUseLegacyStreaming(alias, model, ctx)
              ? await runLegacyStreamModel(model, basePrompt, ctx, event.images, (full) => {
                  partials[alias] = full;
                  updateLiveWidget(ctx, parsed.targets, partials);
                })
              : await runWorkerSession(
                  model,
                  workerPrompt,
                  ctx,
                  history,
                  event.images,
                  getWorkerThinkingLevel(alias, model, thinkingLevel),
                  (full) => {
                    partials[alias] = full;
                    updateLiveWidget(ctx, parsed.targets, partials);
                  },
                );
            return [alias, normalizeWorkerOutcome(alias, model, txt || "(empty response)")] as const;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            // Safety retry: if GLM on a custom provider fails auth, retry on synthetic.
            if (alias === "glm" && model.provider !== "synthetic" && /invalid api key|401|authentication/i.test(message)) {
              const fallback = ctx.modelRegistry.find("synthetic", bind.modelId);
              if (fallback) {
                try {
                  const txt = shouldUseLegacyStreaming(alias, fallback, ctx)
                    ? await runLegacyStreamModel(fallback, basePrompt, ctx, event.images, (full) => {
                        partials[alias] = full;
                        updateLiveWidget(ctx, parsed.targets, partials);
                      })
                    : await runWorkerSession(
                        fallback,
                        workerPrompt,
                        ctx,
                        history,
                        event.images,
                        getWorkerThinkingLevel(alias, fallback, thinkingLevel),
                        (full) => {
                          partials[alias] = full;
                          updateLiveWidget(ctx, parsed.targets, partials);
                        },
                      );
                  return [alias, normalizeWorkerOutcome(alias, fallback, txt || "(empty response)")] as const;
                } catch (retryErr) {
                  const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                  return [alias, normalizeWorkerOutcome(alias, fallback, `Error: ${retryMsg}`)] as const;
                }
              }
            }

            return [alias, normalizeWorkerOutcome(alias, model, `Error: ${message}`)] as const;
          }
        }),
      );

      for (const [alias, txt] of workers) round.outputs[alias] = txt;

      if (parsed.judgeMode && parsed.chosenJudge) {
        const judgeBind = MODEL_MAP[parsed.chosenJudge];
        const judgeModel = ctx.modelRegistry.find(judgeBind.provider, judgeBind.modelId);

        if (!judgeModel) {
          round.judged = `Error: judge model not found (${judgeBind.provider}/${judgeBind.modelId})`;
        } else {
          const judgePrompt = applyWorkerInstructions(buildJudgePrompt(parsed.cleanedPrompt, round.outputs, parsed.chosenJudge));
          try {
            const judged = shouldUseLegacyStreaming(parsed.chosenJudge, judgeModel, ctx)
              ? await runLegacyStreamModel(
                  judgeModel,
                  buildJudgePrompt(parsed.cleanedPrompt, round.outputs, parsed.chosenJudge),
                  ctx,
                  event.images,
                  (full) => {
                    partials.judge = full;
                    updateLiveWidget(ctx, parsed.targets, partials);
                  },
                )
              : await runWorkerSession(
                  judgeModel,
                  judgePrompt,
                  ctx,
                  history,
                  event.images,
                  getWorkerThinkingLevel(parsed.chosenJudge, judgeModel, thinkingLevel),
                  (full) => {
                    partials.judge = full;
                    updateLiveWidget(ctx, parsed.targets, partials);
                  },
                );
            round.judged = judged || "(empty judgment)";
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            round.judged = `Error: ${message}`;
          }
        }
      }

      rounds.push(round);
      pi.appendEntry("model-mesh-round", round);

      pi.sendMessage({
        customType: "model-mesh",
        content: formatRound(round),
        display: true,
        details: round,
      });

      return { action: "handled" as const };
    } finally {
      ctx.ui.setStatus("model-mesh", undefined);
      ctx.ui.setWidget("model-mesh-live", undefined);
    }
  });
}
