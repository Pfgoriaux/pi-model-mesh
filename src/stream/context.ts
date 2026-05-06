let capturedParentContext: {
  contextFilePaths: string[];
  skillNames: string[];
  selectedTools: string[];
  promptGuidelines: string[];
} | null = null;

export function resetCapturedContext(): void {
  capturedParentContext = null;
}

export function buildParentContextBlock(): string {
  if (!capturedParentContext) return "";
  const cc = capturedParentContext;
  const parts: string[] = [];

  if (cc.contextFilePaths.length > 0) {
    parts.push("## Context files loaded by parent extensions");
    for (const p of cc.contextFilePaths) parts.push(`- ${p}`);
  }
  if (cc.skillNames.length > 0) {
    parts.push("## Skills loaded in parent session");
    for (const s of cc.skillNames) parts.push(`- ${s}`);
  }
  if (cc.selectedTools.length > 0) {
    parts.push("## Tools available in parent session");
    parts.push(cc.selectedTools.join(", "));
  }
  if (cc.promptGuidelines.length > 0) {
    parts.push("## Prompt guidelines from parent extensions");
    for (const g of cc.promptGuidelines) parts.push(`- ${g}`);
  }

  return parts.join("\n");
}

export function captureParentContext(opts: any): void {
  capturedParentContext = {
    contextFilePaths: (opts.contextFiles ?? []).map((f: any) => f.path ?? String(f)),
    skillNames: (opts.skills ?? []).map((s: any) => s.name ?? String(s)),
    selectedTools: opts.selectedTools ?? [],
    promptGuidelines: opts.promptGuidelines ?? [],
  };
}

export function getCapturedParentContext() { return capturedParentContext; }
