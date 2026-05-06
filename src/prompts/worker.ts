import type { Alias } from "../types.js";
import { getSystemPromptForAlias } from "./system.js";
import { LEGACY_WORKER_INSTRUCTIONS, LEGACY_SYSTEM_PROMPT, CWD_GUARD_WORKER_PROMPT } from "../config/env.js";

export function applyWorkerInstructions(
  prompt: string,
  alias: Alias | undefined,
  buildParentContextBlock: () => string,
): string {
  const contextBlock = buildParentContextBlock();
  const parts: string[] = [];

  if (alias) {
    const systemPrompt = getSystemPromptForAlias(alias);
    if (systemPrompt) {
      parts.push("# System Instructions", systemPrompt);
    }
  }

  if (LEGACY_WORKER_INSTRUCTIONS) {
    parts.push("# Additional model-mesh instructions", LEGACY_WORKER_INSTRUCTIONS);
  }

  parts.push("# CWD Guard", CWD_GUARD_WORKER_PROMPT);

  if (contextBlock) {
    parts.push(contextBlock);
  }

  if (parts.length > 0) {
    return [...parts, "", prompt].join("\n");
  }

  return prompt;
}

export function buildLegacyWorkerSystemPrompt(alias: Alias | undefined, buildParentContextBlock: () => string): string {
  if (alias) {
    const systemPrompt = getSystemPromptForAlias(alias);
    if (systemPrompt) return systemPrompt;
  }

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
