export type Alias = "claude" | "codex" | "glm";

export type ModelBinding = {
  provider: string;
  modelId: string;
  label: string;
};

export type ResolvedBinding = ModelBinding & {
  source: "env" | "cache" | "registry" | "fallback";
};

export type WorkerToolMode = "none" | "read-only" | "full";

export type WorkerPhase = "pending" | "starting" | "thinking" | "toolcalling" | "streaming" | "done" | "error";

export type StreamActivity =
  | { kind: "text"; delta: string; full: string }
  | { kind: "thinking_start" }
  | { kind: "thinking_delta"; chars: number; totalThinkingChars: number }
  | { kind: "thinking_end" }
  | { kind: "toolcall_start"; toolName: string }
  | { kind: "toolcall_end"; toolName: string };

export interface WorkerStatus {
  alias: Alias;
  phase: WorkerPhase;
  startedAt: number;
  firstActivityAt: number | null;
  firstTextAt: number | null;
  finishedAt: number | null;
  charCount: number;
  thinkingChars: number;
  isThinking: boolean;
  toolCalls: number;
  activeToolName: string | null;
  error: string | null;
  streamPath: "worker" | "legacy" | null;
}

export interface CrossReview {
  reviewer: Alias;
  reviews: Partial<Record<Alias, string>>;
}

export interface ConsensusReport {
  agreements: string[];
  disagreements: string[];
  actionItems: string[];
  verdicts: Partial<Record<Alias, { approved: boolean; confidence: number; notes: string }>>;
}

export interface DeliberationReport {
  proposals: Partial<Record<Alias, string>>;
  critiques: CrossReview[];
  refinements: Partial<Record<Alias, string>>;
  syntheses: Partial<Record<Alias, string>>;
  winner: Alias | null;
  finalPlan: string | null;
  tradeoffs: string[];
  risks: string[];
}

export interface MeshRound {
  id: string;
  createdAt: number;
  prompt: string;
  targets: Alias[];
  deliberation: boolean;
  judge: Alias | null;
  outputs: Partial<Record<Alias, string>>;
  judged: string | null;
  review: boolean;
  crossReviews: CrossReview[];
  consensus: ConsensusReport | null;
  deliberationReport: DeliberationReport | null;
}

export interface LogEntry {
  ts: string;
  roundId: string;
  alias: Alias | "judge" | "mesh" | "review";
  phase: WorkerPhase | "info" | "warn";
  message: string;
}

export const PHASE_ICON: Record<WorkerPhase, string> = {
  pending: "⏳",
  starting: "🚀",
  thinking: "🧠",
  toolcalling: "🔧",
  streaming: "📡",
  done: "✅",
  error: "❌",
};

export type LabelMap = Record<Alias, string>;
