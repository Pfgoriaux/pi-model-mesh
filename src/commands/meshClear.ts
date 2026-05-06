export function registerMeshClear(pi: any, rounds: any[], invalidateWorkerServices: () => void, resetCapturedContext: () => void) {
  pi.registerCommand("mesh-clear", {
    description: "Clear model-mesh round cache for this session",
    handler: async (_args: string, ctx: any) => {
      rounds.length = 0;
      invalidateWorkerServices();
      resetCapturedContext();
      ctx.ui.notify("Model Mesh history cleared", "info");
    },
  });
}
