import type { Alias } from "../types.js";

export const ORDER: Alias[] = ["claude", "codex", "glm"];

export const ALIAS_FAMILIES: Record<Alias, { providers: string[]; modelPatterns: RegExp[]; fallback: { provider: string; modelId: string; label: string } }> = {
  claude: {
    providers: ["anthropic"],
    modelPatterns: [/claude/i],
    fallback: { provider: "anthropic", modelId: "claude-opus-4-7", label: "Claude Code" },
  },
  codex: {
    providers: ["openai-codex"],
    modelPatterns: [/codex/i, /gpt.*codex/i],
    fallback: { provider: "openai-codex", modelId: "gpt-5.3-codex", label: "Codex" },
  },
  glm: {
    providers: ["synthetic"],
    modelPatterns: [/glm/i, /hf:zai-org/i],
    fallback: { provider: "synthetic", modelId: "hf:zai-org/GLM-5.1", label: "GLM 5.1 (Synthetic)" },
  },
};

export function getFallbackBinding(alias: Alias) {
  return ALIAS_FAMILIES[alias].fallback;
}
