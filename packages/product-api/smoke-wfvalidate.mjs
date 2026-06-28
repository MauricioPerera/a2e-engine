// e2e smoke de la validación PRE-EJECUCIÓN de workflows (tier estructura + contexto
// + endpoint /workflows/validate + pre-flight en /execute). Bootea la product API
// (catalog-summary + vault sembrado con my-echo-conn) y dispara requests reales:
//
//   a) workflow VÁLIDO (json convert_text_to_json, input ok)
//        -> POST /workflows/validate ok:true ; POST /execute -> SUCCEEDED.
//   b) ref a step inexistente (2 steps, step2 input usa {{stepX.output}})
//        -> /workflows/validate ok:false 'unknown-step-ref' ; /execute -> 400 workflow_invalid.
//   c) piece inexistente (@foo/piece-nope action x)
//        -> /execute -> 400 'workflow_invalid' con 'piece-not-found' (ANTES del engine,
//           no PieceNotFoundError). También /workflows/validate ok:false piece-not-found.
//   d) connection inexistente (input.auth = {{connections['no-existe']}})
//        -> /workflows/validate ok:false 'connection-not-found' ; /execute -> 400.
//
// Mata todo al final.
import { start, PRODUCT_PORT } from "./src/index.ts";

const BASE = `http://localhost:${PRODUCT_PORT}`;
let failed = false;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};
const hasCode = (findings, code) => Array.isArray(findings) && findings.some((f) => f.code === code);

const jsonStep = (name, input) => ({
  name,
  pieceName: "@activepieces/piece-json",
  pieceVersion: "0.1.8",
  actionName: "convert_text_to_json",
  input,
});

const app = await start();
try {
  // --- a) workflow VÁLIDO --------------------------------------------------
  console.log("\n--- a) workflow válido ---");
  const validSteps = [jsonStep("parse", { text: { a: 1 } })];

  const rVa = await fetch(`${BASE}/workflows/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ steps: validSteps }),
  });
  const bVa = await rVa.json();
  console.log("validate(valid) ->", JSON.stringify(bVa));
  ok("a) validate -> 200", rVa.status === 200, `(status ${rVa.status})`);
  ok("a) validate -> ok:true", bVa.ok === true, JSON.stringify(bVa.findings));
  ok("a) validate -> sin findings de error", !hasCode(bVa.findings, "piece-not-found") && !hasCode(bVa.findings, "unknown-step-ref") && !hasCode(bVa.findings, "connection-not-found"));

  const rVaExe = await fetch(`${BASE}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ steps: validSteps }),
  });
  const bVaExe = await rVaExe.json();
  console.log("execute(valid) ->", JSON.stringify(bVaExe));
  ok("a) execute -> 200", rVaExe.status === 200, `(status ${rVaExe.status})`);
  ok("a) execute -> SUCCEEDED", bVaExe.status === "SUCCEEDED", `(got ${bVaExe.status})`);
  ok("a) execute -> output {a:1}", bVaExe.output && bVaExe.output.a === 1, JSON.stringify(bVaExe.output));

  // --- b) ref a step inexistente ------------------------------------------
  console.log("\n--- b) ref a step inexistente ---");
  const refSteps = [
    jsonStep("s1", { text: "hi" }),
    jsonStep("s2", { text: "{{stepX.output}}" }), // stepX no existe
  ];

  const rVb = await fetch(`${BASE}/workflows/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ steps: refSteps }),
  });
  const bVb = await rVb.json();
  console.log("validate(ref-rota) ->", JSON.stringify(bVb));
  ok("b) validate -> 200", rVb.status === 200, `(status ${rVb.status})`);
  ok("b) validate -> ok:false", bVb.ok === false);
  ok("b) validate -> 'unknown-step-ref'", hasCode(bVb.findings, "unknown-step-ref"), JSON.stringify(bVb.findings));

  const rVbExe = await fetch(`${BASE}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ steps: refSteps }),
  });
  const bVbExe = await rVbExe.json();
  console.log("execute(ref-rota) ->", JSON.stringify(bVbExe));
  ok("b) execute -> 400 pre-flight", rVbExe.status === 400, `(status ${rVbExe.status})`);
  ok("b) execute -> error=workflow_invalid", bVbExe.error === "workflow_invalid", JSON.stringify(bVbExe));
  ok("b) execute -> 'unknown-step-ref'", hasCode(bVbExe.findings, "unknown-step-ref"), JSON.stringify(bVbExe.findings));
  ok("b) execute -> NO ejecuta (sin SUCCEEDED)", bVbExe.status !== "SUCCEEDED");

  // --- c) piece inexistente ----------------------------------------------
  console.log("\n--- c) piece inexistente ---");
  const badPieceSteps = [
    {
      name: "x",
      pieceName: "@foo/piece-nope",
      pieceVersion: "0.0.1",
      actionName: "do_something",
      input: { whatever: "hi" },
    },
  ];

  const rVc = await fetch(`${BASE}/workflows/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ steps: badPieceSteps }),
  });
  const bVc = await rVc.json();
  console.log("validate(piece-nope) ->", JSON.stringify(bVc));
  ok("c) validate -> ok:false", bVc.ok === false);
  ok("c) validate -> 'piece-not-found'", hasCode(bVc.findings, "piece-not-found"), JSON.stringify(bVc.findings));

  const rVcExe = await fetch(`${BASE}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ steps: badPieceSteps }),
  });
  const bVcExe = await rVcExe.json();
  console.log("execute(piece-nope) ->", JSON.stringify(bVcExe));
  ok("c) execute -> 400 pre-flight (ANTES del engine)", rVcExe.status === 400, `(status ${rVcExe.status})`);
  ok("c) execute -> error=workflow_invalid", bVcExe.error === "workflow_invalid", JSON.stringify(bVcExe));
  ok("c) execute -> 'piece-not-found'", hasCode(bVcExe.findings, "piece-not-found"), JSON.stringify(bVcExe.findings));
  ok("c) execute -> NO es PieceNotFoundError del engine (sin 500/execution failed)", rVcExe.status !== 500 && !/PieceNotFoundError|execution failed/.test(JSON.stringify(bVcExe)));

  // --- d) connection inexistente -----------------------------------------
  console.log("\n--- d) connection inexistente ---");
  const badConnSteps = [
    jsonStep("s1", { text: { a: 1 }, auth: "{{connections['no-existe']}}" }),
  ];

  const rVd = await fetch(`${BASE}/workflows/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ steps: badConnSteps }),
  });
  const bVd = await rVd.json();
  console.log("validate(conn-nope) ->", JSON.stringify(bVd));
  ok("d) validate -> 200", rVd.status === 200, `(status ${rVd.status})`);
  ok("d) validate -> ok:false", bVd.ok === false);
  ok("d) validate -> 'connection-not-found'", hasCode(bVd.findings, "connection-not-found"), JSON.stringify(bVd.findings));

  const rVdExe = await fetch(`${BASE}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ steps: badConnSteps }),
  });
  const bVdExe = await rVdExe.json();
  console.log("execute(conn-nope) ->", JSON.stringify(bVdExe));
  ok("d) execute -> 400 pre-flight", rVdExe.status === 400, `(status ${rVdExe.status})`);
  ok("d) execute -> 'connection-not-found'", hasCode(bVdExe.findings, "connection-not-found"), JSON.stringify(bVdExe.findings));
} finally {
  await app.close();
  console.log(failed ? "\n=== SMOKE-WFVALIDATE FAILED ===" : "\n=== SMOKE-WFVALIDATE PASSED ===");
  process.exit(failed ? 1 : 0);
}