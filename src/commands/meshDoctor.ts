import type { Alias, ResolvedBinding, LabelMap } from "../types.js";
import { ORDER } from "../models/aliases.js";
import { WORKER_TOOL_MODE, getWorkerToolNames, MESH_LEGACY_CLAUDE_OAUTH, MESH_FORCE_WORKER_SESSION, MESH_PREVIEW_LENGTH, MESH_WIDGET_THROTTLE_MS, MESH_LOG_INTERVAL_MS, MESH_LOG_INTERVAL_CHARS } from "../config/env.js";
import { getLogsDir } from "../config/paths.js";
import { getStreamingRoute } from "../stream/fallback.js";
import { getCapturedParentContext } from "../stream/context.js";

const CUSTOM_TYPE = "model-mesh";

export function registerMeshDoctor(pi: any, resolvedBindings: Record<Alias, ResolvedBinding>, labels: LabelMap) {
  pi.registerCommand("mesh-doctor", {
    description: "Diagnose model/auth wiring for @claude/@codex/@glm",
    handler: async (_args: string, ctx: any) => {
      const toolNames = getWorkerToolNames(WORKER_TOOL_MODE);
      const lines: string[] = [
        "Model Mesh doctor:",
        `- worker tool mode: ${WORKER_TOOL_MODE} (tools: ${toolNames.join(", ") || "none"})`,
        `- worker services cached: ${getCapturedParentContext() ? "yes" : "no"}`,
        `- worker extensions: disabled (noExtensions: true, prevents recursion)`,
        `- cwd: ${ctx.cwd}`,
        `- log dir: ${getLogsDir()}`,
        `- preview length: ${MESH_PREVIEW_LENGTH} chars`,
        `- widget throttle: ${MESH_WIDGET_THROTTLE_MS}ms`,
        `- progress log interval: ${MESH_LOG_INTERVAL_MS}ms / ${MESH_LOG_INTERVAL_CHARS} chars`,
        `- legacy claude oauth fallback: ${MESH_LEGACY_CLAUDE_OAUTH ? "on" : "off"}`,
        `- force worker session: ${MESH_FORCE_WORKER_SESSION ? "on" : "off"}`,
      ];

      const cc = getCapturedParentContext();
      if (cc) {
        lines.push(`- parent context captured: yes`);
        if (cc.contextFilePaths.length) lines.push(`  context files: ${cc.contextFilePaths.join(", ")}`);
        if (cc.skillNames.length) lines.push(`  skills: ${cc.skillNames.join(", ")}`);
        if (cc.promptGuidelines.length) lines.push(`  guidelines: ${cc.promptGuidelines.length} bullet(s)`);
      } else {
        lines.push(`- parent context captured: no (send a prompt first)`);
      }

      for (const alias of ORDER) {
        const bind = resolvedBindings[alias];
        const model = ctx.modelRegistry.find(bind.provider, bind.modelId);
        lines.push(`- @${alias}: resolved via ${bind.source} → ${bind.provider}/${bind.modelId}`);

        if (!model) {
          lines.push(`  ⚠ model missing in registry`);
          continue;
        }

        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok || !auth.apiKey) {
          const reason = auth.ok ? "missing API key / OAuth" : auth.error;
          lines.push(`  ⚠ AUTH FAIL (${reason})`);
          continue;
        }

        const route = getStreamingRoute(alias, model, ctx, bind);
        const toolNote = route.legacy ? "tools: none (legacy stream)" : "tools: worker-session tools";
        lines.push(`  ✓ OK (${route.reason}, ${toolNote})`);
      }

      pi.sendMessage({
        customType: CUSTOM_TYPE,
        content: lines.join("\n"),
        display: true,
        details: { type: "mesh-doctor" },
      });
    },
  });
}
