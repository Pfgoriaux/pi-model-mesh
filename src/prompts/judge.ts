import type { Alias, CrossReview, LabelMap } from "../types.js";
import { ORDER } from "../models/aliases.js";
import { REVIEW_CROSSCHECK_PROMPT, REVIEW_CONSENSUS_PROMPT } from "./review.js";

export function buildJudgePrompt(userPrompt: string, outputs: Partial<Record<Alias, string>>, judge: Alias, labels: LabelMap): string {
  const outputLines = ORDER
    .filter((a) => outputs[a])
    .map((a) => `## @${a} (${labels[a]})\n${outputs[a]}`)
    .join("\n\n");

  return `You are an expert judge. Compare the following responses from multiple AI models to the same prompt. Evaluate each on accuracy, completeness, and practical value.

Provide:
1. **Rating for each model** (1-10 with brief justification)
2. **Strengths/weaknesses** of each
3. **Best response** with reasoning
4. **Synthesis**: Combine the best insights from all responses into one superior answer

# Prompt
${userPrompt}

${outputLines}`;
}

export function buildCrossReviewPrompt(
  reviewer: Alias,
  outputs: Partial<Record<Alias, string>>,
  originalPrompt: string,
  labels: LabelMap,
): string {
  const otherReviews = ORDER
    .filter((a) => a !== reviewer && outputs[a])
    .map((a) => `## @${a} (${labels[a]}) review\n${outputs[a]}`)
    .join("\n\n");

  return `${REVIEW_CROSSCHECK_PROMPT}\n\n# Original code prompt\n${originalPrompt}\n\n# Your own review\n${outputs[reviewer] || "(not available)"}\n\n# Other models' reviews\n${otherReviews}`;
}

export function buildConsensusPrompt(
  originalPrompt: string,
  outputs: Partial<Record<Alias, string>>,
  crossReviews: CrossReview[],
  labels: LabelMap,
): string {
  const reviewLines = ORDER
    .filter((a) => outputs[a])
    .map((a) => `## @${a} (${labels[a]}) initial review\n${outputs[a]}`)
    .join("\n\n");

  const crossReviewLines = crossReviews
    .map((cr) => {
      const lines = ORDER
        .filter((a) => cr.reviews[a])
        .map((a) => `### ${labels[cr.reviewer]} cross-checking ${labels[a]}\n${cr.reviews[a]}`)
        .join("\n\n");
      return lines;
    })
    .filter(Boolean)
    .join("\n\n");

  return `${REVIEW_CONSENSUS_PROMPT}\n\n# Original code prompt\n${originalPrompt}\n\n# Initial reviews\n${reviewLines}\n\n# Cross-verification\n${crossReviewLines}`;
}
