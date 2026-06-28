// E2E: build a flow with ONE router step (conditional branching) using the
// flow-builder's buildFlowFromRequest, then run it through the bundled engine.
// Verifies that ONLY the matching branch executes.
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
      name: "router1",
      type: "router" as const,
      executionType: "first_match" as const,
      branches: [
        {
          name: "match",
          condition: {
            firstValue: "go",
            operator: "TEXT_EXACTLY_MATCHES",
            secondValue: "go",
          },
          steps: [
            {
              name: "match_action",
              pieceName: "@activepieces/piece-json",
              pieceVersion: "0.1.8",
              actionName: "convert_text_to_json",
              input: { text: '{"branch":"matched","n":1}' },
            },
          ],
        },
        {
          name: "nomatch",
          condition: {
            firstValue: "x",
            operator: "TEXT_EXACTLY_MATCHES",
            secondValue: "y",
          },
          steps: [
            {
              name: "nomatch_action",
              pieceName: "@activepieces/piece-json",
              pieceVersion: "0.1.8",
              actionName: "convert_text_to_json",
              input: { text: '{"branch":"should_not_run"}' },
            },
          ],
        },
      ],
      fallback: {
        name: "fallback",
        steps: [
          {
            name: "fallback_action",
            pieceName: "@activepieces/piece-json",
            pieceVersion: "0.1.8",
            actionName: "convert_text_to_json",
            input: { text: '{"branch":"fallback_ran"}' },
          },
        ],
      },
    },
  ],
};

const flow = buildFlowFromRequest(req as any, lud);

console.log("=== ROUTER NODE SUMMARY ===");
console.log("type:", flow.type);
const branches = (flow as any).settings?.branches ?? [];
console.log("nro branches (incl fallback):", branches.length);
console.log(
  "branch summary:",
  JSON.stringify(
    branches.map((b: any) => ({
      branchType: b.branchType,
      branchName: b.branchName,
      conditions: b.conditions,
    }))
  )
);
const children = (flow as any).children ?? [];
console.log("children count (parallel):", children.length);
console.log(
  "children heads:",
  JSON.stringify(children.map((c: any) => (c ? c.name : null)))
);

(async () => {
  try {
    const result = await executeFlow({ action: flow, port: PORT });
    console.log("\n=== EXECUTION RESULT ===");
    console.log("verdict:", JSON.stringify(result.verdict));
    console.log("steps keys:", JSON.stringify(Object.keys(result.steps || {})));
    for (const [k, v] of Object.entries(result.steps || {})) {
      const s: any = v;
      console.log(
        `STEP ${k}: status=${s.status} output=${JSON.stringify(
          s.output
        )} err=${s.errorMessage ?? ""}`
      );
    }
  } catch (e: any) {
    console.log("\n=== THREW ===");
    console.log(e && e.stack ? e.stack : e);
  }
})();
