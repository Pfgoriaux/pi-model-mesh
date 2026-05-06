import type { Alias, CrossReview, LabelMap } from "../types.js";
import { ORDER } from "../models/aliases.js";

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

const DELIBERATION_CRITIQUE_PROMPT = `You are in a multi-model deliberation. You have already proposed your own solution. Now you will see the other models' proposals.

Your job: critically evaluate each proposal.

For each other proposal:
1. **Strengths**: What does this approach do BETTER than yours? Be honest.
2. **Weaknesses**: Where is this approach weaker or riskier than yours?
3. **Missing pieces**: What did they miss that you covered?
4. **Verdict**: Would you adopt this approach over yours? YES/NO with reason.

Then:
5. **Convergence idea**: Based on all proposals, describe the HYBRID approach that takes the best from each. This is the most important part — don't just pick one, BUILD the best combination.`;

const DELIBERATION_CONVERGENCE_PROMPT = `You are in the final phase of a multi-model deliberation. You have seen the other models' proposals and critiques.

Your job: produce ONE final refined proposal that incorporates the best ideas from all models.

Requirements:
1. **Final approach**: State the approach clearly. If it's a hybrid, explain what you took from each model.
2. **Implementation plan**: Concrete, numbered steps. Someone should be able to execute this without asking questions.
3. **What changed from your initial proposal**: What did you adopt from the other models?
4. **Remaining disagreements**: Are there points where you still disagree with the others? State them.
5. **Confidence**: Rate your confidence 0-100 in this final proposal.

This is the final output. Make it count.`;

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

export { DELIBERATION_PROPOSAL_PROMPT, DELIBERATION_CRITIQUE_PROMPT, DELIBERATION_CONVERGENCE_PROMPT, DELIBERATION_SYNTHESIS_PROMPT };

export function buildDeliberationProposalPrompt(userPrompt: string): string {
  return `${DELIBERATION_PROPOSAL_PROMPT}\n\n# Problem\n${userPrompt}`;
}

export function buildDeliberationCritiquePrompt(
  alias: Alias,
  userPrompt: string,
  outputs: Partial<Record<Alias, string>>,
  labels: LabelMap,
): string {
  const otherProposals = ORDER
    .filter((a) => a !== alias && outputs[a])
    .map((a) => `## ${labels[a]}'s Proposal\n${outputs[a]}`)
    .join("\n\n");

  return `${DELIBERATION_CRITIQUE_PROMPT}\n\n# Original problem\n${userPrompt}\n\n# Your proposal\n${outputs[alias] || "(none)"}\n\n# Other models' proposals\n${otherProposals}`;
}

export function buildDeliberationConvergencePrompt(
  alias: Alias,
  userPrompt: string,
  outputs: Partial<Record<Alias, string>>,
  critiques: CrossReview[],
  labels: LabelMap,
): string {
  const myCritiques = critiques
    .filter((cr) => cr.reviewer === alias)
    .flatMap((cr) => Object.entries(cr.reviews))
    .map(([a, text]) => `### ${labels[a as Alias] || a}'s review of your proposal\n${text}`)
    .join("\n\n");

  const otherCritiques = critiques
    .filter((cr) => cr.reviewer !== alias)
    .flatMap((cr) =>
      Object.entries(cr.reviews).map(
        ([a, text]) => `### ${labels[cr.reviewer]}'s critique mentioning ${labels[a as Alias] || a}\n${text}`,
      ),
    )
    .join("\n\n");

  return `${DELIBERATION_CONVERGENCE_PROMPT}\n\n# Original problem\n${userPrompt}\n\n# All proposals\n${ORDER.filter((a) => outputs[a]).map((a) => `## ${labels[a]}\n${outputs[a]}`).join("\n\n")}\n\n# Critiques of your proposal\n${myCritiques || "(none)"}\n\n# Other critiques\n${otherCritiques || "(none)"}`;
}

export function buildDeliberationSynthesisPrompt(
  userPrompt: string,
  outputs: Partial<Record<Alias, string>>,
  critiques: CrossReview[],
  refinements: Partial<Record<Alias, string>>,
  labels: LabelMap,
): string {
  const proposalsSection = ORDER
    .filter((a) => outputs[a])
    .map((a) => `## ${labels[a]} — Initial Proposal\n${outputs[a]}`)
    .join("\n\n");

  const critiquesSection = critiques
    .map((cr) => {
      const reviewLines = ORDER
        .filter((a) => cr.reviews[a])
        .map((a) => `### ${labels[cr.reviewer]}'s critique of ${labels[a]}\n${cr.reviews[a]}`)
        .join("\n\n");
      return reviewLines;
    })
    .filter(Boolean)
    .join("\n\n");

  const refinementsSection = ORDER
    .filter((a) => refinements[a])
    .map((a) => `## ${labels[a]} — Refined Proposal\n${refinements[a]}`)
    .join("\n\n");

  return `${DELIBERATION_SYNTHESIS_PROMPT}\n\n# Original problem\n${userPrompt}\n\n# Initial Proposals\n${proposalsSection}\n\n# Cross-Critiques\n${critiquesSection || "(none)"}\n\n# Refined Proposals\n${refinementsSection || "(none)"}`;
}
