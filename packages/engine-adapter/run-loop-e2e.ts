// E2E: build a flow with ONE loop step (LOOP_ON_ITEMS) using the flow-builder's
// buildFlowFromRequest, then run it through the bundled engine.
// Goal: prove the loop body runs ONCE PER ITEM and sees the current item.
//
// Contract discovered from the engine source:
//  - loop-executor.ts resolves settings.items via the props-resolver. A single
//    whole-input expression `{{ ["a","b","c"] }}` evaluates to a REAL array.
//  - The loop output (LoopStepOutput) is { item, index, iterations: [...] } where
//    `iterations` is an array of Record<stepName, StepOutput> — one entry per item.
//  - Inside the body the current item is `{{<loopName>.item}}` and the 1-based
//    index is `{{<loopName>.index}}`.
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Point the piece-loader at the json piece BEFORE requiring the engine.
process.env.AP_CUSTOM_PIECES_PATHS = path.join(__dirname, "community-pieces");

const { buildFlowFromRequest } = await import(
  "../flow-builder/src/flow-builder.ts"
);
const require = (await import("node:module")).createRequire(import.meta.url);
const { executeFlow } = require("./src/execute-flow.cjs");

const PORT = process.env.PORT || "3997";
const lud = new Date().toISOString();

const req = {
  steps: [
    {
      name: "loop1",
      type: "loop" as const,
      items: '{{ ["a","b","c"] }}',
      steps: [
        {
          name: "body",
          pieceName: "@activepieces/piece-json",
          pieceVersion: "0.1.8",
          actionName: "convert_text_to_json",
          // The body embeds the current item + index. convert_text_to_json parses
          // this text into JSON, so the resulting output object will reflect the
          // per-iteration item (a/b/c) and index (1/2/3).
          input: { text: '{"item":"{{loop1.output.item}}","idx":{{loop1.output.index}}}' },
        },
      ],
    },
  ],
};

const flow = buildFlowFromRequest(req as any, lud);

console.log("=== LOOP NODE SUMMARY ===");
console.log("type:", flow.type);
console.log("settings.items:", JSON.stringify((flow as any).settings?.items));
const fla = (flow as any).firstLoopAction;
console.log("has firstLoopAction:", !!fla);
console.log(
  "firstLoopAction head:",
  fla ? JSON.stringify({ name: fla.name, type: fla.type, input: fla.settings?.input }) : null
);

(async () => {
  try {
    const result = await executeFlow({ action: flow, port: PORT });
    console.log("\n=== EXECUTION RESULT ===");
    console.log("verdict:", JSON.stringify(result.verdict));
    console.log("steps keys:", JSON.stringify(Object.keys(result.steps || {})));

    const loop: any = (result.steps || {})["loop1"];
    console.log("\n=== LOOP STEP ===");
    console.log("status:", loop && loop.status);
    console.log("err:", loop && loop.errorMessage);
    const out = loop && loop.output;
    console.log("output.item (last):", JSON.stringify(out && out.item));
    console.log("output.index (last):", JSON.stringify(out && out.index));
    const iterations = (out && out.iterations) || [];
    console.log("iterations count:", iterations.length);
    iterations.forEach((it: any, i: number) => {
      const bodyOut = it && it.body;
      console.log(
        `  iter[${i}] body.status=${bodyOut && bodyOut.status} body.output=${JSON.stringify(
          bodyOut && bodyOut.output
        )}`
      );
    });
  } catch (e: any) {
    console.log("\n=== THREW ===");
    console.log(e && e.stack ? e.stack : e);
  }
})();
