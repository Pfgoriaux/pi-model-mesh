// ---------------------------------------------------------------------------
// Prompt templates and builder functions for model-mesh
// ---------------------------------------------------------------------------

import type { Alias, CrossReview } from "./types.js";
import { MODEL_MAP, ORDER, LEGACY_WORKER_INSTRUCTIONS, LEGACY_SYSTEM_PROMPT, CWD_GUARD_WORKER_PROMPT } from "./config.js";

// ---------------------------------------------------------------------------
// Model-specific system prompts
// ---------------------------------------------------------------------------

/** System prompt for Claude models. */
const CLAUDE_SYSTEM_PROMPT = `You are Pi, an expert coding assistant.

- Be concise and direct.
- Prefer native tools over bash for file work. Never use bash to read files.
- Read relevant files before editing or claiming behavior.
- For implementation requests, act once enough context is read.
- Make small focused changes. Match existing patterns.
- Preserve the original code structure and logic. Only change what is strictly necessary.
- Do not rename variables, add helper functions, or introduce new abstractions unless explicitly required.
- Do not add unrelated cleanup, abstractions, or files.
- Verify relevant checks before claiming completion.`;

/** System prompt for Codex models. */
const CODEX_SYSTEM_PROMPT = `You are Pi, an expert coding assistant.

- Be concise.
- Follow explicit constraints exactly.
- Prefer native tools over bash for file work. Never use bash to read files.
- Read relevant code before editing.
- Use a clear loop: inspect, edit, verify.
- Start implementing once enough context is read. Do not churn on planning.
- Preserve the original code and logic of the original code as much as possible. Only change what is strictly necessary.
- Make small focused diffs. Reuse existing patterns. No unrelated changes.
- Do not rename variables, add helper functions, or introduce new abstractions unless explicitly required.
- Do not add error handling, fallbacks, or validation for scenarios that can't happen.
- Do not add docstrings, comments, or type annotations to code you didn't change.
- Run relevant checks before claiming completion.`;

/** System prompt for GLM models (GLM-5, GLM-5.1, GLM-4.7). */
const GLM_SYSTEM_PROMPT = `You are Pi, an expert coding assistant.

- Be concise. Skip filler.
- Prefer native tools over bash for file work. Never use bash to read files.
- Read relevant code before editing or proposing changes.
- Plan briefly, then act. For straightforward tasks, do not spend multiple turns planning.
- If the user asked to implement and enough context is read, start changing code.
- Follow user corrections exactly across turns: names, paths, config keys, commands, scope.
- Before renames, moves, deletions, or path changes, trace imports, config, build, registrations, and runtime usage.
- Treat deletion as high risk. Prove unused first.
- Make small focused diffs. Match existing conventions.
- Preserve the original code structure and logic. Only change what is strictly necessary.
- Do not rename variables, add helper functions, or introduce new abstractions unless explicitly required.
- Prefer to work autonomously; maintain goal alignment across extended sessions.
- Verify after changes, but do not repeat unchanged checks.`;

const ALIAS_SYSTEM_PROMPTS: Record<Alias, string> = {
  claude: CLAUDE_SYSTEM_PROMPT,
  codex: CODEX_SYSTEM_PROMPT,
  glm: GLM_SYSTEM_PROMPT,
};

export function getSystemPromptForAlias(alias: Alias): string {
  return ALIAS_SYSTEM_PROMPTS[alias];
}

// ---------------------------------------------------------------------------
// Review prompts
// ---------------------------------------------------------------------------

export const REVIEW_ANALYSIS_PROMPT = `You are a senior code reviewer. Analyze the code/change described below and provide a structured review.

Your review MUST have these sections:
1. **Summary**: What does this code/change do?
2. **Issues found**: List bugs, logic errors, security issues, edge cases. Use severity: 🔴 critical, 🟠 major, 🟡 minor, 🔵 nit.
3. **Strengths**: What's good about this implementation?
4. **Suggestions**: Concrete improvements (not vague advice).
5. **Verdict**: One of: APPROVE, REQUEST_CHANGES, or NEEDS_DISCUSSION. With a confidence score 0-100.

Be specific. Reference line numbers, variable names, or code patterns. Don't repeat what the code already says.`;

const REVIEW_CROSSCHECK_PROMPT = `You are a senior code reviewer performing cross-verification. You have already reviewed the code yourself. Now you are given reviews from OTHER models.

Your job:
1. For each other review, state whether you AGREE or DISAGREE with each finding.
2. If you disagree, explain WHY with evidence.
3. Identify anything the other reviewer MISSED that you found.
4. Produce a final consolidated assessment.

Format:
- For each other reviewer's finding: ✅ AGREE or ❌ DISAGREE with reason
- **Consolidated issues**: The issues that survive cross-verification
- **Final verdict**: APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION with confidence 0-100`;

const REVIEW_CONSENSUS_PROMPT = `You are a meta-reviewer synthesizing cross-verification results from multiple AI code reviewers.

You receive:
- The original code review prompt
- Each model's independent review
- Each model's cross-verification of the other reviews

Produce a final consensus report:

## ✅ Consensus (all agree)
List issues/observations where ALL reviewers agree.

## ⚠️ Disagreements (needs human attention)
List points where reviewers disagree, with each side's argument.

## 🔍 Action items
Concrete steps the developer should take before merging.

## 📊 Verdict matrix
| Model | Verdict | Confidence | Key concern |

## 🏁 Final recommendation
One clear recommendation: MERGE, FIX_FIRST, or MAJOR_REWORK.`;

// ---------------------------------------------------------------------------
// Deliberation prompt templates
// ---------------------------------------------------------------------------

/** Phase 1: Independent proposal. Each model proposes its solution from scratch. */
const DELIBERATION_PROPOSAL_PROMPT = `You are part of a multi-model deliberation. You will propose a solution independently, then later see and critique other models' proposals.

Your job NOW: propose your best solution to the problem below.

Required structure:
1. **Approach**: Briefly describe your approach and why you chose it.
2. **Implementation plan**: Concrete steps (numbered, specific).
3. **Tradeoffs**: What are the key tradeoffs of your approach?
4. **Risks**: What could go wrong? What edge cases exist?
5. **Alternatives considered**: What other approaches did you consider and why reject them?
6. **Confidence**: Rate your confidence 0-100 in this being the best approach.

Be specific. Vague advice is useless. Show code patterns, file names, data structures.
If you're unsure about something, say so explicitly — that's better than guessing.`;

/** Phase 2: Critique. Each model reviews the OTHERS' proposals. */
const DELIBERATION_CRITIQUE_PROMPT = `You are in a multi-model deliberation. You have already proposed your own solution. Now you will see the other models' proposals.

Your job: critically evaluate each proposal.

For each other proposal:
1. **Strengths**: What does this approach do BETTER than yours? Be honest.
2. **Weaknesses**: Where is this approach weaker or riskier than yours?
3. **Missing pieces**: What did they miss that you covered?
4. **Verdict**: Would you adopt this approach over yours? YES/NO with reason.

Then:
5. **Convergence idea**: Based on all proposals, describe the HYBRID approach that takes the best from each. This is the most important part — don't just pick one, BUILD the best combination.`;

/** Phase 3: Convergence. Each model produces a refined final proposal. */
const DELIBERATION_CONVERGENCE_PROMPT = `You are in the final phase of a multi-model deliberation. You have seen the other models' proposals and critiques.

Your job: produce ONE final refined proposal that incorporates the best ideas from all models.

Requirements:
1. **Final approach**: State the approach clearly. If it's a hybrid, explain what you took from each model.
2. **Implementation plan**: Concrete, numbered steps. Someone should be able to execute this without asking questions.
3. **What changed from your initial proposal**: What did you adopt from the other models?
4. **Remaining disagreements**: Are there points where you still disagree with the others? State them.
5. **Confidence**: Rate your confidence 0-100 in this final proposal.

This is the final output. Make it count.`;

/** Synthesizer: takes all refined proposals and produces THE final plan. */
const DELIBERATION_SYNTHESIS_PROMPT = `You are synthesizing a multi-model deliberation. You have seen three independent proposals, their cross-critiques, and their refined final proposals.

IMPORTANT: You are NOT the sole judge. ALL three models are producing their own synthesis in parallel. Your synthesis will be cross-referenced with the others to find consensus. You must be fair and honest — do not favor your own earlier proposal.

Your job: produce ONE definitive solution plan.

Required structure:

## 🏆 Recommended Approach
The best approach (or hybrid). Explain why this wins. Be honest about what you adopted from others.

## 📋 Implementation Plan
Concrete steps that can be executed immediately. No vagueness.

## ⚖️ Tradeoffs
Key tradeoffs of the recommended approach.

## ⚠️ Risks & Mitigations
Risks and how to handle them.

## 🤝 What Each Model Contributed
| Model | Key contribution |
|-------|-----------------|

## ❌ Remaining Disagreements
Points where models still disagree (if any). State each model's position.

## 🎯 Confidence Score
Overall confidence 0-100 that this plan will work.

Be decisive but fair. You are one voice in a democratic process.`;

// ---------------------------------------------------------------------------
// Deliberation prompt builders
// ---------------------------------------------------------------------------

export function buildDeliberationProposalPrompt(userPrompt: string): string {
  return `${DELIBERATION_PROPOSAL_PROMPT}\n\n# Problem\n${userPrompt}`;
}

export function buildDeliberationCritiquePrompt(
  alias: Alias,
  userPrompt: string,
  outputs: Partial<Record<Alias, string>>,
): string {
  const otherProposals = ORDER
    .filter((a) => a !== alias && outputs[a])
    .map((a) => `## ${MODEL_MAP[a].label}'s Proposal\n${outputs[a]}`)
    .join("\n\n");

  return `${DELIBERATION_CRITIQUE_PROMPT}\n\n# Original problem\n${userPrompt}\n\n# Your proposal\n${outputs[alias] || "(none)"}\n\n# Other models' proposals\n${otherProposals}`;
}

export function buildDeliberationConvergencePrompt(
  alias: Alias,
  userPrompt: string,
  outputs: Partial<Record<Alias, string>>,
  critiques: CrossReview[],
): string {
  const myCritiques = critiques
    .filter((cr) => cr.reviewer === alias)
    .flatMap((cr) => Object.entries(cr.reviews))
    .map(([a, text]) => `### ${MODEL_MAP[a as Alias]?.label || a}'s review of your proposal\n${text}`)
    .join("\n\n");

  const otherCritiques = critiques
    .filter((cr) => cr.reviewer !== alias)
    .flatMap((cr) =>
      Object.entries(cr.reviews).map(
        ([a, text]) => `### ${MODEL_MAP[cr.reviewer].label}'s critique mentioning ${MODEL_MAP[a as Alias]?.label || a}\n${text}`,
      ),
    )
    .join("\n\n");

  return `${DELIBERATION_CONVERGENCE_PROMPT}\n\n# Original problem\n${userPrompt}\n\n# All proposals\n${ORDER.filter((a) => outputs[a]).map((a) => `## ${MODEL_MAP[a].label}\n${outputs[a]}`).join("\n\n")}\n\n# Critiques of your proposal\n${myCritiques || "(none)"}\n\n# Other critiques\n${otherCritiques || "(none)"}`;
}

export function buildDeliberationSynthesisPrompt(
  userPrompt: string,
  outputs: Partial<Record<Alias, string>>,
  critiques: CrossReview[],
  refinements: Partial<Record<Alias, string>>,
): string {
  const proposalsSection = ORDER
    .filter((a) => outputs[a])
    .map((a) => `## ${MODEL_MAP[a].label} — Initial Proposal\n${outputs[a]}`)
    .join("\n\n");

  const critiquesSection = critiques
    .map((cr) => {
      const reviewLines = ORDER
        .filter((a) => cr.reviews[a])
        .map((a) => `### ${MODEL_MAP[cr.reviewer].label}'s critique of ${MODEL_MAP[a].label}\n${cr.reviews[a]}`)
        .join("\n\n");
      return reviewLines;
    })
    .filter(Boolean)
    .join("\n\n");

  const refinementsSection = ORDER
    .filter((a) => refinements[a])
    .map((a) => `## ${MODEL_MAP[a].label} — Refined Proposal\n${refinements[a]}`)
    .join("\n\n");

  return `${DELIBERATION_SYNTHESIS_PROMPT}\n\n# Original problem\n${userPrompt}\n\n# Initial Proposals\n${proposalsSection}\n\n# Cross-Critiques\n${critiquesSection || "(none)"}\n\n# Refined Proposals\n${refinementsSection || "(none)"}`;
}

// ---------------------------------------------------------------------------
// Judge prompt builder
// ---------------------------------------------------------------------------

export function buildJudgePrompt(userPrompt: string, outputs: Partial<Record<Alias, string>>, judge: Alias): string {
  const outputLines = ORDER
    .filter((a) => outputs[a])
    .map((a) => `## @${a} (${MODEL_MAP[a].label})\n${outputs[a]}`)
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

// ---------------------------------------------------------------------------
// Cross-review prompt builder
// ---------------------------------------------------------------------------

export function buildCrossReviewPrompt(
  reviewer: Alias,
  outputs: Partial<Record<Alias, string>>,
  originalPrompt: string,
): string {
  const otherReviews = ORDER
    .filter((a) => a !== reviewer && outputs[a])
    .map((a) => `## @${a} (${MODEL_MAP[a].label}) review\n${outputs[a]}`)
    .join("\n\n");

  return `${REVIEW_CROSSCHECK_PROMPT}\n\n# Original code prompt\n${originalPrompt}\n\n# Your own review\n${outputs[reviewer] || "(not available)"}\n\n# Other models' reviews\n${otherReviews}`;
}

// ---------------------------------------------------------------------------
// Consensus prompt builder
// ---------------------------------------------------------------------------

export function buildConsensusPrompt(
  originalPrompt: string,
  outputs: Partial<Record<Alias, string>>,
  crossReviews: CrossReview[],
): string {
  const reviewLines = ORDER
    .filter((a) => outputs[a])
    .map((a) => `## @${a} (${MODEL_MAP[a].label}) initial review\n${outputs[a]}`)
    .join("\n\n");

  const crossReviewLines = crossReviews
    .map((cr) => {
      const lines = ORDER
        .filter((a) => cr.reviews[a])
        .map((a) => `### ${MODEL_MAP[cr.reviewer].label} cross-checking ${MODEL_MAP[a].label}\n${cr.reviews[a]}`)
        .join("\n\n");
      return lines;
    })
    .filter(Boolean)
    .join("\n\n");

  return `${REVIEW_CONSENSUS_PROMPT}\n\n# Original code prompt\n${originalPrompt}\n\n# Initial reviews\n${reviewLines}\n\n# Cross-verification\n${crossReviewLines}`;
}

// ---------------------------------------------------------------------------
// Worker instruction builders
// ---------------------------------------------------------------------------

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
