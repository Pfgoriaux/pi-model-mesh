import type { Alias } from "../types.js";
import { ORDER } from "../models/aliases.js";

export function stripTags(text: string): string {
  return text.replace(/(^|\s)@[a-zA-Z0-9:_-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function parseInput(text: string): {
  targets: Alias[];
  cleanedPrompt: string;
  deliberation: boolean;
  judgeMode: boolean;
  chosenJudge: Alias | null;
  reviewMode: boolean;
  deliberationMode: boolean;
} {
  const tokenRegex = /(^|\s)@([a-zA-Z0-9:_-]+)/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(text)) !== null) found.add(m[2].toLowerCase());

  const reviewMode = found.has("review");
  const deliberationMode = found.has("deliberate") || found.has("debate") || /\bdeliberat(e|ion|ing)\b/i.test(text);
  const hasAll = found.has("all") || reviewMode || deliberationMode;
  const aliases = ORDER.filter((a) => found.has(a));

  const judgeToken = Array.from(found).find((t) => t.startsWith("judge"));
  const judgeMode = Boolean(judgeToken) || reviewMode || deliberationMode;

  let chosenJudge: Alias | null = null;
  const judgeInline = judgeToken?.match(/^judge[:_-](claude|codex|glm)$/i);
  if (judgeInline) {
    chosenJudge = judgeInline[1].toLowerCase() as Alias;
  }

  let targets = hasAll ? [...ORDER] : aliases;
  if (targets.length === 0 && (judgeMode || reviewMode || deliberationMode)) targets = [...ORDER];

  if (!chosenJudge && judgeMode) {
    const explicitJudgeInText = text.match(/\bjudge\s*[=:]\s*(claude|codex|glm)\b/i);
    if (explicitJudgeInText) chosenJudge = explicitJudgeInText[1].toLowerCase() as Alias;
  }

  if (!chosenJudge && judgeMode) chosenJudge = "claude";

  const cleanedPrompt = stripTags(text)
    .replace(/\b(review|deliberat(e|ion|ing)|debate)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return { targets, cleanedPrompt, deliberation: deliberationMode, judgeMode, chosenJudge, reviewMode, deliberationMode };
}
