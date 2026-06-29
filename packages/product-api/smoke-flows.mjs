// smoke-flows.mjs — e2e de retrieve_flows (descubrimiento/reuso de WORKFLOWS
// guardados con gates de confianza VALIDEZ + SALUD) sobre product-api.
//
// Arranca el product-api IN-PROCESS con WORKFLOWS_REPO + RUNS_REPO en dirs
// temporales (aislados del host):
//   (a) POST /workflows x2: un flujo json VÁLIDO (convert_text_to_json) y un
//       flujo INVALIDO/stale que referencia una action/piece inexistente (cuyo
//       nombre contiene "json" para que q=json lo devuelva y lo marque).
//   (b) POST /workflows/:validId/execute x2 -> SUCCEEDED -> 2 runs enlazados al
//       workflow por workflowId (visible en el frontmatter del run).
//   (c) GET /flows/retrieve?q=json -> incluye el flujo válido con
//       health "2 runs, 100% ok, last SUCCEEDED" + validity valid; el inválido
//       marcado invalid + "0 runs (untested)".
// Confirma el enlace workflowId en los runs leyendo el markdown de cada run.
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

// WORKFLOWS_REPO y RUNS_REPO se setean ANTES del import dinámico de index.ts
// (handlers.ts los lee al cargar el módulo). PORT único para no chocar con
// otros smokes corriendo en paralelo.
process.env.WORKFLOWS_REPO = mkdtempSync(path.join(os.tmpdir(), "ap-flows-wf-"));
process.env.RUNS_REPO = mkdtempSync(path.join(os.tmpdir(), "ap-flows-runs-"));
process.env.PORT = "8123";

const { start, PRODUCT_PORT } = await import("./src/index.ts");
const BASE = `http://localhost:${PRODUCT_PORT}`;

let failed = false;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};

const VALID_ID = "wf-smoke-valid-json";
const INVALID_ID = "wf-smoke-stale-json";

const validStep = {
  name: "parse",
  pieceName: "@activepieces/piece-json",
  pieceVersion: "0.1.8",
  actionName: "convert_text_to_json",
  input: { text: '{"a":1}' },
};
// Stale: referencia una piece que NO existe en el catálogo -> piece-not-found
// (gate de VALIDEZ). Nombre contiene "json" para que q=json la devuelva.
const staleStep = {
  name: "missing",
  pieceName: "@activepieces/piece-nonexistent",
  pieceVersion: "0.0.0",
  actionName: "do_thing",
  input: { x: "y" },
};

const app = await start();
try {
  // (a) Guardar 2 workflows.
  const rValid = await fetch(`${BASE}/workflows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: VALID_ID,
      name: "Parse JSON",
      description: "Convert text to JSON with piece-json.",
      steps: [validStep],
    }),
  });
  const bValid = await rValid.json();
  console.log("POST /workflows (valid) ->", JSON.stringify(bValid));
  ok("save valid workflow -> 201", rValid.status === 201, `(status ${rValid.status})`);
  ok("valid id echoed", bValid.id === VALID_ID, `(id ${bValid.id})`);

  const rInvalid = await fetch(`${BASE}/workflows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: INVALID_ID,
      name: "Stale JSON flow",
      description: "References a removed action; should be flagged invalid.",
      steps: [staleStep],
    }),
  });
  const bInvalid = await rInvalid.json();
  console.log("POST /workflows (invalid) ->", JSON.stringify(bInvalid));
  ok("save invalid workflow -> 201", rInvalid.status === 201, `(status ${rInvalid.status})`);
  ok("invalid id echoed", bInvalid.id === INVALID_ID, `(id ${bInvalid.id})`);

  // (b) Ejecutar el válido 2 veces -> SUCCEEDED -> runs con workflowId.
  for (let i = 1; i <= 2; i++) {
    const r = await fetch(`${BASE}/workflows/${VALID_ID}/execute`, { method: "POST" });
    const b = await r.json();
    console.log(`POST /workflows/:id/execute #${i} ->`, JSON.stringify(b));
    ok(`execute valid #${i} -> 200`, r.status === 200, `(status ${r.status})`);
    ok(`execute valid #${i} SUCCEEDED`, b.status === "SUCCEEDED", `(got ${b.status})`);
    ok(`execute valid #${i} output {a:1}`, b.output && b.output.a === 1, JSON.stringify(b.output));
  }

  // Confirma el enlace workflowId leyendo el markdown de cada run. RUNS_REPO
  // es temporal y sólo tiene los 2 runs recién creados.
  const rRuns = await fetch(`${BASE}/runs`);
  const bRuns = await rRuns.json();
  console.log("--- GET /runs ---");
  console.log(JSON.stringify(bRuns, null, 2));
  ok("GET /runs -> 200", rRuns.status === 200, `(status ${rRuns.status})`);
  ok("exactly 2 runs recorded", (bRuns.runs ?? []).length === 2, `(runs ${bRuns.runs?.length})`);
  for (const row of bRuns.runs ?? []) {
    const rMd = await fetch(`${BASE}/runs/${row.date}/${row.runId}`);
    const md = await rMd.text();
    ok(`run ${row.runId} markdown has workflowId: ${VALID_ID}`, new RegExp(`workflowId: ${VALID_ID}`).test(md), `(status ${row.status})`);
    ok(`run ${row.runId} SUCCEEDED`, row.status === "SUCCEEDED", `(status ${row.status})`);
  }

  // (c) GET /flows/retrieve?q=json
  const rRet = await fetch(`${BASE}/flows/retrieve?q=json&budget=4000`);
  const bRet = await rRet.json();
  console.log("--- GET /flows/retrieve?q=json ---");
  console.log(JSON.stringify(bRet, null, 2));
  ok("GET /flows/retrieve -> 200", rRet.status === 200, `(status ${rRet.status})`);
  ok("retrieve total === 2 (both match 'json')", bRet.total === 2, `(total ${bRet.total})`);
  ok("retrieve included has valid id", (bRet.included ?? []).includes(VALID_ID), `(${bRet.included?.join(",")})`);
  ok("retrieve included has invalid id", (bRet.included ?? []).includes(INVALID_ID), `(${bRet.included?.join(",")})`);
  ok("retrieve omitted === 0 (both fit budget)", bRet.omitted === 0, `(omitted ${bRet.omitted})`);
  ok("estimatedTokens > 0", typeof bRet.estimatedTokens === "number" && bRet.estimatedTokens > 0, `(${bRet.estimatedTokens})`);

  const ctx = String(bRet.context ?? "");
  console.log("--- retrieve context ---");
  console.log(ctx);
  console.log("--- end retrieve context ---");

  // Flujo válido: validity valid + health "2 runs, 100% ok, last SUCCEEDED".
  ok("context has valid flow header", new RegExp(`## Parse JSON  \\(id: ${VALID_ID}\\)`).test(ctx), "");
  ok("context has valid flow validity: valid", /validity: valid\nhealth: 2 runs, 100% ok, last SUCCEEDED/.test(ctx), "");
  ok("context has valid flow health line", /health: 2 runs, 100% ok, last SUCCEEDED/.test(ctx), "");
  ok("context has valid flow pieces", /pieces: @activepieces\/piece-json/.test(ctx), "");

  // Flujo inválido: validity invalid + health "0 runs (untested)".
  ok("context has invalid flow header", new RegExp(`## Stale JSON flow  \\(id: ${INVALID_ID}\\)`).test(ctx), "");
  ok("context has invalid flow validity: invalid", /validity: invalid — /.test(ctx), "");
  ok("context has invalid flow health untested", /health: 0 runs \(untested\)/.test(ctx), "");
  ok("context has invalid flow piece-not-found reason", /piece-not-found/.test(ctx), "");
} finally {
  await app.close();
  try { rmSync(process.env.WORKFLOWS_REPO ?? "", { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(process.env.RUNS_REPO ?? "", { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(failed ? "\n=== SMOKE-FLOWS FAILED ===" : "\n=== SMOKE-FLOWS PASSED ===");
  process.exit(failed ? 1 : 0);
}