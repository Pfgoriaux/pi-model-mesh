export function registerMeshAbort(pi: any, getCurrentAbort: () => AbortController | null) {
  pi.registerCommand("mesh-abort", {
    description: "Abort the currently running model-mesh round",
    handler: async (_args: string, ctx: any) => {
      const abort = getCurrentAbort();
      if (abort && !abort.signal.aborted) {
        abort.abort();
        ctx.ui.notify("Model Mesh round aborted", "warning");
      } else {
        ctx.ui.notify("No active mesh round to abort", "info");
      }
    },
  });
}
