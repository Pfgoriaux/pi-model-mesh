import type { Alias, CrossReview, DeliberationReport, MeshRound, LabelMap, ResolvedBinding } from "../types.js";
import { ORDER } from "../models/aliases.js";
import { preview } from "./text.js";

export function formatRound(round: MeshRound, labels: LabelMap): string {
  const rows = ORDER
    .filter((a) => round.targets.includes(a))
    .map((a) => `## @${a} — ${labels[a]}\n${round.outputs[a] || "(no output)"}`)
    .join("\n\n");

  const judge = round.judge
    ? `\n\n## @judge (${labels[round.judge]})\n${round.judged || "(no judgment)"}`
    : "";

  let crossReviewSection = "";
  if (round.crossReviews && round.crossReviews.length > 0 && !round.deliberationReport) {
    const reviewBlocks = round.crossReviews
      .map((cr) => {
        const reviewLines = ORDER
          .filter((a) => cr.reviews[a])
          .map((a) => `### ${labels[a]} reviewed by ${labels[cr.reviewer]}\n${cr.reviews[a]}`)
          .join("\n\n");
        return reviewLines;
      })
      .filter(Boolean)
      .join("\n\n");
    if (reviewBlocks) {
      crossReviewSection = `\n\n---\n\n## 🔄 Cross-Verification\n${reviewBlocks}`;
    }
  }

  let consensusSection = "";
  if (round.consensus) {
    const c = round.consensus;
    const parts: string[] = ["## 📊 Consensus"];
    if (c.agreements.length > 0) {
      parts.push(`\n### ✅ Agreements\n${c.agreements.map((a) => `- ${a}`).join("\n")}`);
    }
    if (c.disagreements.length > 0) {
      parts.push(`\n### ⚠️ Disagreements\n${c.disagreements.map((d) => `- ${d}`).join("\n")}`);
    }
    if (c.actionItems.length > 0) {
      parts.push(`\n### 🔍 Action Items\n${c.actionItems.map((a) => `- ${a}`).join("\n")}`);
    }
    if (Object.keys(c.verdicts).length > 0) {
      parts.push("\n### 📋 Verdicts");
      parts.push("| Model | Verdict | Confidence |");
      parts.push("|-------|---------|------------|");
      for (const alias of ORDER) {
        const v = c.verdicts[alias];
        if (v) {
          parts.push(`| ${labels[alias]} | ${v.approved ? "✅ APPROVE" : "❌ REQUEST_CHANGES"} | ${v.confidence}% |`);
        }
      }
    }
    consensusSection = `\n\n---\n\n${parts.join("\n")}`;
  }

  let deliberationSection = "";
  if (round.deliberationReport) {
    deliberationSection = formatDeliberationReport(round.deliberationReport, labels);
  }

  const titleTag = round.review
    ? "(code review)"
    : round.deliberationReport
      ? "(deliberation)"
      : round.deliberation
        ? "(deliberation)"
        : "(analysis)";

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

function formatDeliberationReport(dr: DeliberationReport, labels: LabelMap): string {
  const parts: string[] = [];

  if (dr.finalPlan) {
    parts.push("## 🏆 FINAL PLAN\n");
    parts.push(dr.finalPlan);
  }

  if (Object.keys(dr.proposals).length > 0) {
    parts.push("\n---\n\n## 📝 Summary\n");
    for (const alias of ORDER) {
      const proposal = dr.proposals[alias];
      if (proposal) {
        const approachMatch = proposal.match(/\*\*Approach\*\*[:\s]*([^\n]+)/i);
        const confidenceMatch = proposal.match(/\*\*Confidence\*\*[:\s]*(\d+)/i);
        const approachLine = approachMatch ? approachMatch[1].trim() : preview(proposal, 120);
        const confidenceLine = confidenceMatch ? ` (${confidenceMatch[1]}% confidence)` : "";
        parts.push(`- **${labels[alias]}**: ${approachLine}${confidenceLine}`);
      }
    }

    if (dr.tradeoffs.length > 0) {
      parts.push("\n**Tradeoffs:**");
      for (const t of dr.tradeoffs) parts.push(`- ${t}`);
    }
    if (dr.risks.length > 0) {
      parts.push("\n**Risks:**");
      for (const r of dr.risks) parts.push(`- ${r}`);
    }
  }

  if (Object.keys(dr.proposals).length > 0) {
    parts.push("\n---\n\n## 📄 Details\n");
    for (const alias of ORDER) {
      if (dr.proposals[alias]) {
        parts.push(`<details><summary>${labels[alias]} — Initial Proposal</summary>\n`);
        parts.push(dr.proposals[alias]!);
        parts.push("\n</details>\n");
      }
    }
    for (const alias of ORDER) {
      if (dr.refinements[alias]) {
        parts.push(`<details><summary>${labels[alias]} — Refined Proposal</summary>\n`);
        parts.push(dr.refinements[alias]!);
        parts.push("\n</details>\n");
      }
    }
    if (dr.syntheses && Object.keys(dr.syntheses).length > 0) {
      parts.push("\n---\n\n## ⚖️ Individual Syntheses\n");
      for (const alias of ORDER) {
        if (dr.syntheses[alias]) {
          parts.push(`<details><summary>${labels[alias]}'s Synthesis</summary>\n`);
          parts.push(dr.syntheses[alias]!);
          parts.push("\n</details>\n");
        }
      }
    }
  }

  return parts.join("\n");
}

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

export function buildConvergedPlan(
  syntheses: Partial<Record<Alias, string>>,
  userPrompt: string,
  labels: LabelMap,
): string {
  const activeSynths = ORDER.filter((a) => syntheses[a]);
  const parts: string[] = [];

  parts.push("# 🏆 CONVERGED PLAN\n");
  parts.push("This plan was synthesized **democratically** — all models produced independent syntheses, and this output extracts their consensus.\n");

  const confidences: Partial<Record<Alias, number>> = {};
  const recommendations: Partial<Record<Alias, string>> = {};

  for (const alias of activeSynths) {
    const text = syntheses[alias]!;
    const confMatch = text.match(/confidence[:\s]*(\d{1,3})/i);
    confidences[alias] = confMatch ? parseInt(confMatch[1], 10) : undefined;

    const approachMatch = text.match(/##?\s*Recommended\s+Approach[^\n]*\n([\s\S]*?)(?=##?\s|$)/i);
    recommendations[alias] = approachMatch ? approachMatch[1].trim() : preview(text, 200);
  }

  parts.push("## 📊 Scorecard\n");
  parts.push("| Model | Confidence | Recommended Approach |");
  parts.push("|-------|-----------|----------------------|");
  for (const alias of activeSynths) {
    const conf = confidences[alias];
    const rec = recommendations[alias] ? preview(recommendations[alias]!, 80) : "(see synthesis)";
    parts.push(`| ${labels[alias]} | ${conf != null ? conf : "?"}% | ${rec} |`);
  }
  parts.push("");

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

  parts.push("## ✅ Consensus\n");
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
      const supporterLabels = supporters.map((a) => labels[a]).join(", ");
      parts.push(`- ${item} _(${supporterLabels})_`);
    }
  } else {
    parts.push("See individual syntheses for details.");
  }
  parts.push("");

  const tradeoffs = extractTradeoffs(baseText);
  if (tradeoffs.length > 0) {
    parts.push("## ⚖️ Tradeoffs\n");
    for (const t of tradeoffs) parts.push(`- ${t}`);
    parts.push("");
  }

  const risks = extractRisks(baseText);
  if (risks.length > 0) {
    parts.push("## ⚠️ Risks\n");
    for (const r of risks) parts.push(`- ${r}`);
    parts.push("");
  }

  parts.push("## 🤝 Contributions\n");
  parts.push("| Model | Key contribution | Confidence |");
  parts.push("|-------|-------------------|------------|");
  for (const alias of activeSynths) {
    const text = syntheses[alias]!;
    const contribRegex = new RegExp(`\\|\\s*${labels[alias]}\\s*\\|([^|]+)\\|`);
    const contribMatch = text.match(contribRegex);
    const contrib = contribMatch ? contribMatch[1].trim() : preview(text, 60);
    parts.push(`| ${labels[alias]} | ${contrib} | ${confidences[alias] ?? "?"}% |`);
  }
  parts.push("");

  parts.push("## ❌ Disagreements\n");
  const disagreementMatch = baseText.match(/##?\s*Remaining\s+Disagreements?[^\n]*\n([\s\S]*?)(?=##?\s|$)/i);
  if (disagreementMatch && disagreementMatch[1].trim()) {
    parts.push(disagreementMatch[1].trim());
  } else {
    parts.push("None identified — models converged on the approach.");
  }
  parts.push("");

  parts.push("## 🎯 Overall Confidence\n");
  const validConfidences = activeSynths.map((a) => confidences[a]).filter((c): c is number => c != null);
  if (validConfidences.length > 0) {
    const avg = Math.round(validConfidences.reduce((s, c) => s + c, 0) / validConfidences.length);
    const min = Math.min(...validConfidences);
    const max = Math.max(...validConfidences);
    parts.push(`**Average:** ${avg}% · **Range:** ${min}%–${max}%`);
    if (max - min > 20) {
      parts.push("> ⚠️ Large confidence spread — review the disagreements above.");
    }
  } else {
    parts.push("(confidence scores not extracted from syntheses)");
  }
  parts.push("");

  parts.push("---\n");
  parts.push("## 📄 Individual Syntheses\n");
  for (const alias of activeSynths) {
    parts.push(`<details><summary>${labels[alias]}'s Synthesis</summary>\n`);
    parts.push(syntheses[alias]!);
    parts.push("\n</details>\n");
  }

  return parts.join("\n");
}
