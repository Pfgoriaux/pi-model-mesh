import { streamSimple, type AssistantMessage, type Message, type Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Alias = "claude" | "codex" | "kimi" | "glm";

type ModelBinding = {
  provider: string;
  modelId: string;
  label: string;
};

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

function assistantText(msg: AssistantMessage): string {
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
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

const DEFAULT_SYSTEM_PROMPT = process.env.MESH_SYSTEM_PROMPT?.trim() || "You are a helpful coding assistant.";

async function streamModel(
  model: Model<any>,
  prompt: string,
  ctx: any,
  onChunk: (chunk: string, full: string) => void,
): Promise<string> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    const msg = auth.ok ? `Missing API key for ${model.provider}/${model.id}` : auth.error;
    throw new Error(msg);
  }

  const user: Message = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };

  const events = streamSimple(model, { systemPrompt: DEFAULT_SYSTEM_PROMPT, messages: [user] }, {
    apiKey: auth.apiKey,
    headers: auth.headers,
    signal: ctx.signal,
  });

  let full = "";
  for await (const event of events) {
    if (event.type === "text_delta") {
      full += event.delta;
      onChunk(event.delta, full);
    }
    if (event.type === "done") {
      const doneText = assistantText(event.message);
      return doneText || full;
    }
    if (event.type === "error") {
      throw new Error(event.error.errorMessage || "Unknown streaming error");
    }
  }

  return full.trim();
}

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

  pi.on("session_start", async (_event, ctx) => {
    rounds.length = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "model-mesh-round") continue;
      const data = entry.data as MeshRound | undefined;
      if (!data || !data.id || !Array.isArray(data.targets)) continue;
      rounds.push(data);
    }
  });

  pi.registerCommand("mesh-clear", {
    description: "Clear model-mesh round cache for this session",
    handler: async (_args, ctx) => {
      rounds.length = 0;
      ctx.ui.notify("Model Mesh history cleared", "info");
    },
  });

  pi.registerCommand("mesh-doctor", {
    description: "Diagnose model/auth wiring for @claude/@codex/@kimi/@glm",
    handler: async (_args, ctx) => {
      const lines: string[] = ["Model Mesh doctor:"];

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
    const workerPrompt = parsed.deliberation
      ? buildDeliberationPrompt(parsed.cleanedPrompt, last)
      : parsed.cleanedPrompt;

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
            const txt = await streamModel(model, workerPrompt, ctx, (_chunk, full) => {
              partials[alias] = full;
              updateLiveWidget(ctx, parsed.targets, partials);
            });
            return [alias, txt || "(empty response)"] as const;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            // Safety retry: if GLM on a custom provider fails auth, retry on synthetic.
            if (alias === "glm" && model.provider !== "synthetic" && /invalid api key|401|authentication/i.test(message)) {
              const fallback = ctx.modelRegistry.find("synthetic", bind.modelId);
              if (fallback) {
                try {
                  const txt = await streamModel(fallback, workerPrompt, ctx, (_chunk, full) => {
                    partials[alias] = full;
                    updateLiveWidget(ctx, parsed.targets, partials);
                  });
                  return [alias, txt || "(empty response)"] as const;
                } catch (retryErr) {
                  const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                  return [alias, `Error: ${retryMsg}`] as const;
                }
              }
            }

            return [alias, `Error: ${message}`] as const;
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
          const judgePrompt = buildJudgePrompt(parsed.cleanedPrompt, round.outputs, parsed.chosenJudge);
          try {
            const judged = await streamModel(judgeModel, judgePrompt, ctx, (_chunk, full) => {
              partials.judge = full;
              updateLiveWidget(ctx, parsed.targets, partials);
            });
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
