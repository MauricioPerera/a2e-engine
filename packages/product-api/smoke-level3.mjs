// smoke-level3.mjs — e2e del NIVEL 3 de descubrimiento: cuando el agente hace
// retrieve_actions de una piece, cada action además muestra los FLUJOS
// GUARDADOS, VALIDOS y SANOS que la USAN (receta probada). Reusa el gate de
// validez+salud de retrieve-flows.
//
// Arranca el product-api IN-PROCESS con WORKFLOWS_REPO + RUNS_REPO en dirs
// temporales (aislados del host):
//   (a) POST /workflows: un flujo que usa @activepieces/piece-json action
//       convert_text_to_json (receta válida).
//   (b) POST /workflows/:id/execute x2 -> SUCCEEDED -> 2 runs enlazados al
//       workflow por workflowId (salud 2 runs, 100%).
//   (c) GET /catalog/pieces/@activepieces/piece-json/actions?q=convert&budget=4000
//       -> en el detalle de `convert_text_to_json` aparece el flujo guardado
//       (id + name + validity:valid + health "2 runs, 100% ok, last SUCCEEDED").
//   (d) Esparsidad: GET .../actions (sin query, budget=8000) lista TODAS las
//       actions; `run_jsonata_query` (sin flujos) NO trae la sección "flows que
//       la usan" (0 coste), mientras `convert_text_to_json` sí la trae.
// Confirma budget respetado (shape {context, included, total, omitted,
// estimatedTokens} intacto) y no-regresión del nivel 2.
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

// WORKFLOWS_REPO y RUNS_REPO se setean ANTES del import dinámico de index.ts
// (handlers.ts los lee al cargar el módulo). PORT único para no chocar con
// otros smokes corriendo en paralelo.
process.env.WORKFLOWS_REPO = mkdtempSync(path.join(os.tmpdir(), "ap-l3-wf-"));
process.env.RUNS_REPO = mkdtempSync(path.join(os.tmpdir(), "ap-l3-runs-"));
process.env.PORT = "8124";

const { start, PRODUCT_PORT } = await import("./src/index.ts");
const BASE = `http://localhost:${PRODUCT_PORT}`;

let failed = false;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};

const WF_ID = "wf-level3-json";
const WF_NAME = "Level3 JSON recipe";
const PIECE = "@activepieces/piece-json";

const validStep = {
  name: "parse",
  pieceName: PIECE,
  pieceVersion: "0.1.8",
  actionName: "convert_text_to_json",
  input: { text: '{"a":1}' },
};

// Devuelve el bloque OKF de una action dentro del contexto renderizado
// (subsección entre `### <actionName>` y el siguiente `### ` o fin). '' si no.
function actionBlock(context, actionName) {
  const idx = context.indexOf(`### ${actionName}`);
  if (idx === -1) return "";
  const rest = context.slice(idx + `### ${actionName}`.length);
  const next = rest.indexOf("\n### ");
  return next === -1 ? rest : rest.slice(0, next);
}

const app = await start();
try {
  // (a) Guardar el workflow (receta válida con convert_text_to_json).
  const rSave = await fetch(`${BASE}/workflows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: WF_ID,
      name: WF_NAME,
      description: "Convert text to JSON — reusable recipe for piece-json.",
      steps: [validStep],
    }),
  });
  const bSave = await rSave.json();
  console.log("POST /workflows ->", JSON.stringify(bSave));
  ok("save recipe workflow -> 201", rSave.status === 201, `(status ${rSave.status})`);
  ok("recipe id echoed", bSave.id === WF_ID, `(id ${bSave.id})`);

  // (b) Ejecutar 2 veces -> SUCCEEDED -> 2 runs enlazados al workflow (salud).
  for (let i = 1; i <= 2; i++) {
    const r = await fetch(`${BASE}/workflows/${WF_ID}/execute`, { method: "POST" });
    const b = await r.json();
    console.log(`POST /workflows/:id/execute #${i} ->`, JSON.stringify(b));
    ok(`execute #${i} -> 200`, r.status === 200, `(status ${r.status})`);
    ok(`execute #${i} SUCCEEDED`, b.status === "SUCCEEDED", `(got ${b.status})`);
    ok(`execute #${i} output {a:1}`, b.output && b.output.a === 1, JSON.stringify(b.output));
  }

  // (c) NIVEL 3 enganchado: GET .../actions?q=convert&budget=4000.
  const rAct = await fetch(
    `${BASE}/catalog/pieces/${encodeURIComponent(PIECE)}/actions?q=convert&budget=4000`,
  );
  const bAct = await rAct.json();
  console.log("--- GET /catalog/pieces/:name/actions?q=convert&budget=4000 ---");
  console.log(JSON.stringify(bAct, null, 2));
  ok("GET actions -> 200", rAct.status === 200, `(status ${rAct.status})`);
  // Shape intacto (no-regresión del nivel 2).
  ok("shape has context/included/total/omitted/estimatedTokens",
    typeof bAct.context === "string" &&
      Array.isArray(bAct.included) &&
      typeof bAct.total === "number" &&
      typeof bAct.omitted === "number" &&
      typeof bAct.estimatedTokens === "number",
    `(keys ${Object.keys(bAct).join(",")})`);
  ok("convert_text_to_json included", (bAct.included ?? []).includes("convert_text_to_json"),
    `(${bAct.included?.join(",")})`);
  ok("budget respected (estimatedTokens <= 4000)",
    typeof bAct.estimatedTokens === "number" && bAct.estimatedTokens <= 4000,
    `(${bAct.estimatedTokens})`);

  const ctx = String(bAct.context ?? "");
  const convertBlock = actionBlock(ctx, "convert_text_to_json");
  console.log("--- convert_text_to_json block ---");
  console.log(convertBlock);
  console.log("--- end block ---");

  // El flujo guardado aparece en el detalle de convert_text_to_json:
  //   "flows que la usan:" + "  - [wf-level3-json] Level3 JSON recipe (valid, 2 runs, 100% ok, last SUCCEEDED)"
  ok("convert block has 'flows que la usan:'", /flows que la usan:/.test(convertBlock), "");
  ok("convert block has flow line with id",
    new RegExp(`- \\[${WF_ID}\\] `).test(convertBlock), "");
  ok("convert block has flow name", new RegExp(`\\] ${WF_NAME}`).test(convertBlock), "");
  ok("convert block has validity: valid", /\(valid,/.test(convertBlock), "");
  ok("convert block has health 2 runs 100%",
    /2 runs, 100% ok, last SUCCEEDED/.test(convertBlock), "");

  // (d) Esparsidad: sin query, budget=8000 -> TODAS las actions. run_jsonata_query
  // (sin flujos) NO trae "flows que la usan"; convert_text_to_json sí.
  const rAll = await fetch(
    `${BASE}/catalog/pieces/${encodeURIComponent(PIECE)}/actions?budget=8000`,
  );
  const bAll = await rAll.json();
  console.log("--- GET .../actions?budget=8000 (all) ---");
  console.log(JSON.stringify(bAll, null, 2));
  ok("GET all actions -> 200", rAll.status === 200, `(status ${rAll.status})`);
  ok("all actions: 4 included",
    (bAll.included ?? []).length === 4 && bAll.total === 4,
    `(included ${bAll.included?.length}, total ${bAll.total})`);

  const ctxAll = String(bAll.context ?? "");
  const jsonataBlock = actionBlock(ctxAll, "run_jsonata_query");
  console.log("--- run_jsonata_query block ---");
  console.log(jsonataBlock);
  console.log("--- end block ---");
  ok("run_jsonata_query block present", jsonataBlock.length > 0, "");
  ok("run_jsonata_query has NO 'flows que la usan' (sparse)",
    !/flows que la usan:/.test(jsonataBlock), "(no recipe attached)");
  ok("convert_text_to_json (all) still has flow",
    /flows que la usan:/.test(actionBlock(ctxAll, "convert_text_to_json")), "");
  ok("all-actions budget respected (estimatedTokens <= 8000)",
    typeof bAll.estimatedTokens === "number" && bAll.estimatedTokens <= 8000,
    `(${bAll.estimatedTokens})`);
} finally {
  await app.close();
  try { rmSync(process.env.WORKFLOWS_REPO ?? "", { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(process.env.RUNS_REPO ?? "", { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(failed ? "\n=== SMOKE-LEVEL3 FAILED ===" : "\n=== SMOKE-LEVEL3 PASSED ===");
  process.exit(failed ? 1 : 0);
}