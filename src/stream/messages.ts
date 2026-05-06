export function textOrErrorFromAssistantMessage(
  msg: { content?: Array<{ type: string; text?: string }>; stopReason?: string; errorMessage?: string } | null | undefined,
): string {
  if (!msg?.content) {
    if (msg && (msg.stopReason === "error" || msg.stopReason === "aborted") && msg.errorMessage) {
      return `Error: ${msg.errorMessage}`;
    }
    return "";
  }
  const text = msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  if (text) return text;
  if ((msg.stopReason === "error" || msg.stopReason === "aborted") && msg.errorMessage) {
    return `Error: ${msg.errorMessage}`;
  }
  return "";
}

export function findLastAssistantOutcome(
  messages: Array<{ role?: string; content?: Array<{ type: string; text?: string }>; stopReason?: string; errorMessage?: string }>,
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== "assistant") continue;
    const outcome = textOrErrorFromAssistantMessage(messages[i]);
    if (outcome) return outcome;
  }
  return "";
}

export function cloneValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function sanitizeWorkerHistory(history: unknown[]): unknown[] {
  return history.filter((message) => {
    if (!message || typeof message !== "object") return false;
    const msg = message as { role?: string; customType?: string };
    return !(msg.role === "custom" && msg.customType?.startsWith("model-mesh"));
  });
}
