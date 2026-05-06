// ---------------------------------------------------------------------------
// Formatting helpers for model-mesh
// ---------------------------------------------------------------------------

import type { Alias, CrossReview, DeliberationReport, MeshRound, WorkerPhase, WorkerStatus } from "./types.js";
import { PHASE_ICON } from "./types.js";
import { MODEL_MAP, ORDER, MESH_PREVIEW_LENGTH } from "./config.js";

// ---------------------------------------------------------------------------
// Utility formatters
// ---------------------------------------------------------------------------

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${(s % 60).toFixed(0)}s`;
}

export function preview(text: string, max = MESH_PREVIEW_LENGTH): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "…";
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

// ---------------------------------------------------------------------------
// Widget builders
// ---------------------------------------------------------------------------

export function createWorkerStatus(alias: Alias): WorkerStatus {
  return {
    alias,
    phase: "pending",
    startedAt: 0,
    firstActivityAt: null,
    firstTextAt: null,
    finishedAt: null,
    charCount: 0,
    thinkingChars: 0,
    isThinking: false,
    toolCalls: 0,
    activeToolName: null,
    error: null,
    streamPath: null,
  };
}

/** Mark a worker as done and update all relevant fields. */
export function markDone(
  status: WorkerStatus,
  charCount: number,
  partials: Partial<Record<Alias | "judge", string>>,
  alias: Alias | "judge",
  text: string,
): void {
  status.phase = "done";
  status.finishedAt = Date.now();
  status.charCount = charCount;
  status.isThinking = false;
  status.activeToolName = null;
  partials[alias] = text;
}

/** Mark a worker as errored. */
export function markError(
  status: WorkerStatus,
  message: string,
): void {
  status.phase = "error";
  status.error = message;
  status.finishedAt = Date.now();
  status.isThinking = false;
  status.activeToolName = null;
}

export function buildActivityLabel(s: WorkerStatus): string {
  const pathTag = s.streamPath === "legacy" ? " [no tools]" : "";
  if (s.isThinking) {
    const thinkChars = s.thinkingChars > 1000 ? `${(s.thinkingChars / 1000).toFixed(1)}k` : `${s.thinkingChars}`;
    return `thinking ${thinkChars} chars${pathTag}`;
  }
  if (s.activeToolName) {
    return `🔧 ${s.activeToolName}${pathTag}`;
  }
  if (s.toolCalls > 0 && s.phase === "streaming") {
    return `${s.charCount} chars · 🔧${s.toolCalls}${pathTag}`;
  }
  if (s.phase === "done" && s.toolCalls > 0) {
    return `${s.charCount} chars · 🔧${s.toolCalls} calls${pathTag}`;
  }
  if (s.charCount > 0) {
    return `${s.charCount} chars${pathTag}`;
  }
  if (s.streamPath === "legacy") {
    return `connecting (legacy, no tools)`;
  }
  return "connecting…";
}

export function buildWidgetLines(
  targets: Alias[],
  statuses: Partial<Record<Alias | "judge", WorkerStatus>>,
  partials: Partial<Record<Alias | "judge", string>>,
): string[] {
  const now = Date.now();
  const lines: string[] = ["╔══ Model Mesh ═══════════════════════════════════════════════╗"];

  const allKeys: Array<Alias | "judge"> = [...targets];
  if (statuses.judge) allKeys.push("judge");

  for (const key of allKeys) {
    const s = statuses[key];
    const text = partials[key] || "";
    const tag = key === "judge" ? "@judge " : `@${key.padEnd(6)}`;

    if (!s) {
      lines.push(`║ ⏳ ${tag} — unknown`);
      continue;
    }

    const icon = PHASE_ICON[s.phase];
    const elapsed = s.startedAt ? formatElapsed(now - s.startedAt) : "—";
    const ttfb = s.firstActivityAt && s.startedAt ? `ttfb:${formatElapsed(s.firstActivityAt - s.startedAt)}` : "";
    const activity = buildActivityLabel(s);
    const meta = [elapsed, activity, ttfb].filter(Boolean).join(" · ");

    if (s.phase === "error") {
      const errMsg = s.error ? preview(s.error, 60) : "unknown error";
      lines.push(`║ ${icon} ${tag} — ERROR ${elapsed}`);
      lines.push(`║   ${errMsg}`);
    } else if (s.phase === "streaming" || s.phase === "done") {
      lines.push(`║ ${icon} ${tag} — ${meta}`);
      if (text) lines.push(`║   ${preview(text, 70)}`);
    } else if (s.phase === "thinking") {
      lines.push(`║ ${icon} ${tag} — ${meta}`);
    } else if (s.phase === "toolcalling") {
      lines.push(`║ ${icon} ${tag} — ${meta}`);
    } else {
      lines.push(`║ ${icon} ${tag} — ${meta}`);
    }
  }

  lines.push("╚════════════════════════════════════════════════════════════╝");
  return lines;
}

export function updateLiveWidget(
  ctx: any,
  targets: Alias[],
  statuses: Partial<Record<Alias | "judge", WorkerStatus>>,
  partials: Partial<Record<Alias | "judge", string>>,
) {
  const lines = buildWidgetLines(targets, statuses, partials);
  ctx.ui.setWidget("model-mesh-live", lines, { placement: "belowEditor" });
}

// ---------------------------------------------------------------------------
// Throttled updater
// ---------------------------------------------------------------------------

export interface ThrottledUpdater {
  (fn: () => void): void;
  flush(): void;
}

export function createThrottledUpdater(intervalMs: number): ThrottledUpdater {
  let last = 0;
  let pending: (() => void) | null = null;
  const throttled = ((fn: () => void) => {
    const now = Date.now();
    if (now - last >= intervalMs) {
      last = now;
      pending = null;
      fn();
    } else {
      pending = fn;
    }
  }) as ThrottledUpdater;
  throttled.flush = () => {
    if (pending) {
      const fn = pending;
      pending = null;
      last = Date.now();
      fn();
    }
  };
  return throttled;
}

// ---------------------------------------------------------------------------
// Round formatting (the big one)
// ---------------------------------------------------------------------------

export function formatRound(round: MeshRound): string {
  const rows = ORDER
    .filter((a) => round.targets.includes(a))
    .map((a) => `## @${a} — ${MODEL_MAP[a].label}\n${round.outputs[a] || "(no output)"}`)
    .join("\n\n");

  const judge = round.judge
    ? `\n\n## @judge (${MODEL_MAP[round.judge].label})\n${round.judged || "(no judgment)"}`
    : "";

  // Cross-review section (used by both @review and @deliberate)
  let crossReviewSection = "";
  if (round.crossReviews && round.crossReviews.length > 0 && !round.deliberationReport) {
    const reviewBlocks = round.crossReviews
      .map((cr) => {
        const reviewLines = ORDER
          .filter((a) => cr.reviews[a])
          .map((a) => `### ${MODEL_MAP[a].label} reviewed by ${MODEL_MAP[cr.reviewer].label}\n${cr.reviews[a]}`)
          .join("\n\n");
        return reviewLines;
      })
      .filter(Boolean)
      .join("\n\n");
    if (reviewBlocks) {
      crossReviewSection = `\n\n---\n\n## 🔄 Cross-Verification\n${reviewBlocks}`;
    }
  }

  // Consensus section (review mode)
  let consensusSection = "";
  if (round.consensus) {
    const c = round.consensus;
    const parts: string[] = ["## 📊 Consensus Report"];
    if (c.agreements.length > 0) {
      parts.push(`\n### ✅ Agreements (all models agree)\n${c.agreements.map((a) => `- ${a}`).join("\n")}`);
    }
    if (c.disagreements.length > 0) {
      parts.push(`\n### ⚠️ Disagreements (needs human attention)\n${c.disagreements.map((d) => `- ${d}`).join("\n")}`);
    }
    if (c.actionItems.length > 0) {
      parts.push(`\n### 🔍 Action Items\n${c.actionItems.map((a) => `- ${a}`).join("\n")}`);
    }
    if (Object.keys(c.verdicts).length > 0) {
      parts.push("\n### 📋 Verdict Matrix");
      parts.push("| Model | Verdict | Confidence | Notes |");
      parts.push("|-------|---------|------------|-------|");
      for (const alias of ORDER) {
        const v = c.verdicts[alias];
        if (v) {
          parts.push(`| ${MODEL_MAP[alias].label} | ${v.approved ? "✅ APPROVE" : "❌ REQUEST_CHANGES"} | ${v.confidence}% | ${v.notes.slice(0, 60)} |`);
        }
      }
    }
    consensusSection = `\n\n---\n\n${parts.join("\n")}`;
  }

  // Deliberation report section (deliberation mode)
  let deliberationSection = "";
  if (round.deliberationReport) {
    deliberationSection = formatDeliberationReport(round.deliberationReport);
  }

  const titleTag = round.review
    ? "(code review)"
    : round.deliberationReport
      ? "(deliberation)"
      : round.deliberation
        ? "(deliberation)"
        : "(analysis)";

  // For deliberation mode, the final plan IS the main output
  if (round.deliberationReport) {
    return [
      `# Model Mesh ${titleTag}`,
      `**Problem:** ${round.prompt || "(none)"}`,
      deliberationSection,
    ].join("\n\n");
  }

  return [
    `# Model Mesh ${titleTag}`,
    `**Prompt:** ${round.prompt || "(none)"}`,
    rows,
    judge,
    crossReviewSection,
    consensusSection,
  ].join("\n\n");
}

function formatDeliberationReport(dr: DeliberationReport): string {
  const parts: string[] = [];

  // --- The final plan is the star ---
  if (dr.finalPlan) {
    parts.push("## 🏆 FINAL PLAN — The Recommended Solution\n");
    parts.push(dr.finalPlan);
  }

  // --- Summary of contributions ---
  if (Object.keys(dr.proposals).length > 0) {
    parts.push("\n---\n\n## 📝 How We Got Here (Summary)\n");

    for (const alias of ORDER) {
      const proposal = dr.proposals[alias];
      if (proposal) {
        const approachMatch = proposal.match(/\*\*Approach\*\*[:\s]*([^\n]+)/i);
        const confidenceMatch = proposal.match(/\*\*Confidence\*\*[:\s]*(\d+)/i);
        const approachLine = approachMatch ? approachMatch[1].trim() : preview(proposal, 120);
        const confidenceLine = confidenceMatch ? ` (${confidenceMatch[1]}% confidence)` : "";
        parts.push(`- **${MODEL_MAP[alias].label}**: ${approachLine}${confidenceLine}`);
      }
    }

    if (dr.tradeoffs.length > 0) {
      parts.push("\n**Key Tradeoffs:**");
      for (const t of dr.tradeoffs) parts.push(`- ${t}`);
    }
    if (dr.risks.length > 0) {
      parts.push("\n**Risks:**");
      for (const r of dr.risks) parts.push(`- ${r}`);
    }
  }

  // --- Full proposals (collapsible details) ---
  if (Object.keys(dr.proposals).length > 0) {
    parts.push("\n---\n\n## 📄 Full Proposals (Details)\n");
    for (const alias of ORDER) {
      if (dr.proposals[alias]) {
        parts.push(`### ${MODEL_MAP[alias].label} — Initial Proposal`);
        parts.push(dr.proposals[alias]!);
        parts.push("");
      }
    }
    for (const alias of ORDER) {
      if (dr.refinements[alias]) {
        parts.push(`### ${MODEL_MAP[alias].label} — Refined Proposal`);
        parts.push(dr.refinements[alias]!);
        parts.push("");
      }
    }
    // Individual syntheses (Phase 4 democratic output)
    if (dr.syntheses && Object.keys(dr.syntheses).length > 0) {
      parts.push("\n---\n\n## ⚖️ Individual Syntheses (Democratic Phase 4)\n");
      parts.push("Each model's independent synthesis — the converged plan above was derived from their consensus.\n");
      for (const alias of ORDER) {
        if (dr.syntheses[alias]) {
          parts.push(`### ${MODEL_MAP[alias].label}'s Synthesis`);
          parts.push(dr.syntheses[alias]!);
          parts.push("");
        }
      }
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Consensus parsing
// ---------------------------------------------------------------------------

export function parseConsensusFromText(
  text: string,
  outputs: Partial<Record<Alias, string>>,
): { agreements: string[]; disagreements: string[]; actionItems: string[]; verdicts: Record<string, { approved: boolean; confidence: number; notes: string }> } {
  const agreements: string[] = [];
  const disagreements: string[] = [];
  const actionItems: string[] = [];
  const verdicts: Record<string, { approved: boolean; confidence: number; notes: string }> = {};

  const extractSection = (pattern: RegExp) => {
    const match = text.match(pattern);
    if (!match) return [];
    return match[1].split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
  };

  agreements.push(...extractSection(/##?\s*Consensus[^\n]*\n([\s\S]*?)(?=##?\s|$)/i));
  disagreements.push(...extractSection(/##?\s*Disagreements?[^\n]*\n([\s\S]*?)(?=##?\s|$)/i));
  actionItems.push(...extractSection(/##?\s*Action\s*items?[^\n]*\n([\s\S]*?)(?=##?\s|$)/i));

  for (const alias of ORDER) {
    if (!outputs[alias]) continue;
    const review = outputs[alias]!;
    const verdictMatch = review.match(/\b(APPROVE|REQUEST_CHANGES|NEEDS_DISCUSSION)\b/i);
    const confidenceMatch = review.match(/confidence[:\s]*(\d{1,3})/i);

    if (verdictMatch) {
      verdicts[alias] = {
        approved: /APPROVE/i.test(verdictMatch[1]),
        confidence: confidenceMatch ? parseInt(confidenceMatch[1], 10) : 50,
        notes: preview(review, 80),
      };
    }
  }

  if (agreements.length === 0 && disagreements.length === 0 && actionItems.length === 0) {
    agreements.push("See full consensus text for details");
  }

  return { agreements, disagreements, actionItems, verdicts };
}

// ---------------------------------------------------------------------------
// Deliberation text extraction helpers
// ---------------------------------------------------------------------------

export function extractTradeoffs(text: string): string[] {
  const match = text.match(/##?\s*Tradeoffs?[^\n]*\n([\s\S]*?)(?=##?\s|$)/i);
  if (!match) return [];
  return match[1].split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
}

export function extractRisks(text: string): string[] {
  const match = text.match(/##?\s*Risks?[^\n]*\n([\s\S]*?)(?=##?\s|$)/i);
  if (!match) return [];
  return match[1].split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Democratic plan convergence — extract consensus from ALL model syntheses
// ---------------------------------------------------------------------------

export function buildConvergedPlan(
  syntheses: Partial<Record<Alias, string>>,
  userPrompt: string,
): string {
  const activeSynths = ORDER.filter((a) => syntheses[a]);
  const parts: string[] = [];

  parts.push("# 🏆 CONVERGED PLAN\n");
  parts.push("This plan was synthesized **democratically** — all 3 models produced independent syntheses of the deliberation, and this output extracts their consensus. No single model owns the final answer.\n");

  // Extract confidence scores from each synthesis
  const confidences: Partial<Record<Alias, number>> = {};
  const recommendations: Partial<Record<Alias, string>> = {};

  for (const alias of activeSynths) {
    const text = syntheses[alias]!;
    const confMatch = text.match(/confidence[:\s]*(\d{1,3})/i);
    confidences[alias] = confMatch ? parseInt(confMatch[1], 10) : undefined;

    const approachMatch = text.match(/##?\s*Recommended\s+Approach[^\n]*\n([\s\S]*?)(?=##?\s|$)/i);
    recommendations[alias] = approachMatch ? approachMatch[1].trim() : preview(text, 200);
  }

  // Democracy scorecard
  parts.push("## 📊 Democracy Scorecard\n");
  parts.push("| Model | Confidence | Recommended Approach |");
  parts.push("|-------|-----------|----------------------|");
  for (const alias of activeSynths) {
    const conf = confidences[alias];
    const rec = recommendations[alias] ? preview(recommendations[alias]!, 80) : "(see full synthesis)";
    parts.push(`| ${MODEL_MAP[alias].label} | ${conf != null ? conf : "?"}% | ${rec} |`);
  }
  parts.push("");

  // Find the best synthesis as base
  const sortedByConfidence = [...activeSynths].sort((a, b) => (confidences[b] ?? 0) - (confidences[a] ?? 0));
  const baseAlias = sortedByConfidence[0];
  const baseText = syntheses[baseAlias]!;

  const implPlanMatch = baseText.match(/##?\s*Implementation\s+Plan[^\n]*\n([\s\S]*?)(?=##?\s|$)/i);

  parts.push("## 📋 Implementation Plan\n");
  if (implPlanMatch) {
    parts.push(implPlanMatch[1].trim());
  } else {
    parts.push(baseText);
  }
  parts.push("");

  // Cross-reference: what ALL models agree on
  parts.push("## ✅ Points of Consensus (all models agree)\n");
  const allActionItems: Map<string, Alias[]> = new Map();
  for (const alias of activeSynths) {
    const text = syntheses[alias]!;
    const bulletRegex = /^[-*]\s+(.+)$/gm;
    let match: RegExpExecArray | null;
    while ((match = bulletRegex.exec(text)) !== null) {
      const item = match[1].trim();
      if (item.length < 10) continue;
      const keyWords = item.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
      const supporting: Alias[] = [alias];
      for (const otherAlias of activeSynths) {
        if (otherAlias === alias) continue;
        const otherText = (syntheses[otherAlias] || "").toLowerCase();
        const matchCount = keyWords.filter((w) => otherText.includes(w)).length;
        if (keyWords.length > 0 && matchCount / keyWords.length >= 0.4) {
          supporting.push(otherAlias);
        }
      }
      if (supporting.length >= 2) {
        const key = item.slice(0, 80);
        if (!allActionItems.has(key)) {
          allActionItems.set(key, supporting);
        }
      }
    }
  }

  if (allActionItems.size > 0) {
    for (const [item, supporters] of allActionItems) {
      const supporterLabels = supporters.map((a) => MODEL_MAP[a].label).join(", ");
      parts.push(`- ${item} _(${supporterLabels})_`);
    }
  } else {
    parts.push("All models produced independent syntheses — see individual outputs for details.");
  }
  parts.push("");

  // Tradeoffs (from base, augmented)
  const tradeoffs = extractTradeoffs(baseText);
  if (tradeoffs.length > 0) {
    parts.push("## ⚖️ Tradeoffs\n");
    for (const t of tradeoffs) parts.push(`- ${t}`);
    parts.push("");
  }

  // Risks (from base, augmented)
  const risks = extractRisks(baseText);
  if (risks.length > 0) {
    parts.push("## ⚠️ Risks & Mitigations\n");
    for (const r of risks) parts.push(`- ${r}`);
    parts.push("");
  }

  // What each model contributed
  parts.push("## 🤝 What Each Model Contributed\n");
  parts.push("| Model | Key contribution | Confidence |");
  parts.push("|-------|-------------------|------------|");
  for (const alias of activeSynths) {
    const text = syntheses[alias]!;
    const contribRegex = new RegExp(`\\|\\s*${MODEL_MAP[alias].label}\\s*\\|([^|]+)\\|`);
    const contribMatch = text.match(contribRegex);
    const contrib = contribMatch ? contribMatch[1].trim() : preview(text, 60);
    parts.push(`| ${MODEL_MAP[alias].label} | ${contrib} | ${confidences[alias] ?? "?"}% |`);
  }
  parts.push("");

  // Remaining disagreements
  parts.push("## ❌ Remaining Disagreements\n");
  const disagreementMatch = baseText.match(/##?\s*Remaining\s+Disagreements?[^\n]*\n([\s\S]*?)(?=##?\s|$)/i);
  if (disagreementMatch && disagreementMatch[1].trim()) {
    parts.push(disagreementMatch[1].trim());
  } else {
    parts.push("None identified — models converged on the approach.");
  }
  parts.push("");

  // Overall confidence
  parts.push("## 🎯 Overall Confidence\n");
  const validConfidences = activeSynths.map((a) => confidences[a]).filter((c): c is number => c != null);
  if (validConfidences.length > 0) {
    const avg = Math.round(validConfidences.reduce((s, c) => s + c, 0) / validConfidences.length);
    const min = Math.min(...validConfidences);
    const max = Math.max(...validConfidences);
    parts.push(`**Average:** ${avg}% · **Range:** ${min}%–${max}%`);
    if (max - min > 20) {
      parts.push("> ⚠️ Large confidence spread — models disagree on how certain they are. Review the disagreements above.");
    }
  } else {
    parts.push("(confidence scores not extracted from syntheses)");
  }
  parts.push("");

  // Full individual syntheses
  parts.push("---\n");
  parts.push("## 📄 Individual Syntheses (Full)\n");
  parts.push("These are each model's independent synthesis. The converged plan above is derived from their consensus.\n");
  for (const alias of activeSynths) {
    parts.push(`### ${MODEL_MAP[alias].label}'s Synthesis`);
    parts.push(syntheses[alias]!);
    parts.push("");
  }

  return parts.join("\n");
}
