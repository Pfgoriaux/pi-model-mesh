import { parseInput } from "../input/parse.js";

const CUSTOM_TYPE = "model-mesh";

export function registerMeshDiff(pi: any) {
  pi.registerCommand("mesh-diff", {
    description: "Run @review on git diff (unstaged changes by default, or specify a ref like HEAD~1 or main..HEAD)",
    getArgumentCompletions: (prefix: string) => {
      const refs = ["HEAD", "HEAD~1", "HEAD~2", "main", "main..HEAD", "master", "develop"];
      const filtered = refs.filter((r) => r.toLowerCase().startsWith(prefix.toLowerCase()));
      return filtered.length > 0 ? filtered.map((r) => ({ value: r, label: r })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const diffRef = args.trim() || "";
      let diffCommand: string;
      let diffDescription: string;

      if (diffRef) {
        diffCommand = `git diff ${diffRef}`;
        diffDescription = `git diff ${diffRef}`;
      } else {
        diffCommand = `git diff HEAD`;
        diffDescription = "git diff HEAD (unstaged + staged)";
      }

      let diff: string;
      try {
        const { execSync } = await import("node:child_process");
        diff = execSync(diffCommand, { cwd: ctx.cwd, encoding: "utf-8", timeout: 10_000 }).trim();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to get git diff: ${msg.slice(0, 100)}`, "error");
        return;
      }

      if (!diff) {
        ctx.ui.notify("No diff found — working tree is clean", "info");
        return;
      }

      const maxDiffChars = parseInt(process.env.MESH_MAX_DIFF_CHARS?.trim() || "50000", 10);
      const truncated = diff.length > maxDiffChars;
      const diffContent = truncated ? diff.slice(0, maxDiffChars) + "\n... (truncated, set MESH_MAX_DIFF_CHARS to increase)" : diff;

      let changedFiles = "";
      try {
        const { execSync } = await import("node:child_process");
        changedFiles = execSync(`git diff --stat ${diffRef || "HEAD"}`, { cwd: ctx.cwd, encoding: "utf-8", timeout: 5_000 }).trim();
      } catch { /* best effort */ }

      const reviewPrompt = [
        `Review the following git diff (${diffDescription}):`,
        "",
        changedFiles ? `Changed files:\n\`${changedFiles}\`` : "",
        "",
        "```diff",
        diffContent,
        "```",
      ].filter(Boolean).join("\n");

      const fakeEvent = { text: `@review ${reviewPrompt}`, images: [] };
      const parsed = parseInput(fakeEvent.text);
      if (parsed.targets.length === 0) {
        ctx.ui.notify("@review tag not parsed correctly", "error");
        return;
      }

      ctx.ui.notify(`Use: @review <paste diff or describe what to review>`, "info");
      pi.sendMessage({
        customType: CUSTOM_TYPE,
        content: `Diff captured (${diff.length} chars). Run:\n@review ${diffDescription}\n\nOr copy this prompt:\n\`\`\`\n@review Review the following git diff (${diffDescription}):\n\n${changedFiles ? `Changed files: ${changedFiles}` : ""}\n\n(Diff: ${diff.length} chars)\n\`\`\``,
        display: true,
        details: { type: "mesh-diff-result", diff: diffContent, diffDescription, changedFiles },
      });
    },
  });
}
