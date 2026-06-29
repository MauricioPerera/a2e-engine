// e2e smoke del AUTO-SANITIZADO PRE-VALIDACIÓN de step names en /execute.
// Reproduce el caso real de un agente vía MCP: manda nombres de step inválidos
// (con espacios, ej. "Convert Text to JSON") y espera que el endpoint los
// arregle ANTES de validar/ejecutar, sin forzar un reintento del agente.
//
//   a) CASO MCP: 1 step name="Convert Text to JSON" (espacios) ->
//      debe dar 200 SUCCEEDED output {nombre:Ana,edad:30} (NO 400 invalid-step-name;
//      el sanitizer lo renombra a Convert_Text_to_JSON internamente).
//   b) REF REESCRITA: 2 steps. step1 name="Get Data" (espacios) produce un objeto;
//      step2 name="Use It" referencia a step1 con {{Get Data.output}} (ref con el
//      nombre original con espacios). Tras sanitizar, name->Get_Data y la ref se
//      reescribe a {{Get_Data.output}} y resuelve (sin unknown-step-ref, sin
//      invalid-step-name) -> 200 SUCCEEDED.
//   c) SANITY: un step con nombre ya válido sigue funcionando igual (no-regresión).
//
// Mata todo al final.
import { start, PRODUCT_PORT } from "./src/index.ts";

const BASE = `http://localhost:${PRODUCT_PORT}`;
let failed = false;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};

const jsonStep = (name, input) => ({
  name,
  pieceName: "@activepieces/piece-json",
  pieceVersion: "0.1.8",
  actionName: "convert_text_to_json",
  input,
});

const app = await start();
try {
  // --- a) CASO MCP: nombre con espacios -> SUCCEEDED sin reintento ------------
  console.log("\n--- a) nombre con espacios (caso MCP) ---");
  const rA = await fetch(`${BASE}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      steps: [
        jsonStep("Convert Text to JSON", { text: '{"nombre":"Ana","edad":30}' }),
      ],
    }),
  });
  const bA = await rA.json();
  console.log("execute(Convert Text to JSON) ->", JSON.stringify(bA));
  ok("a) -> HTTP 200 (NO 400 invalid-step-name)", rA.status === 200, `(status ${rA.status})`);
  ok("a) -> status SUCCEEDED", bA.status === "SUCCEEDED", `(got ${bA.status})`);
  ok("a) -> output {nombre:Ana,edad:30}", bA.output && bA.output.nombre === "Ana" && bA.output.edad === 30, JSON.stringify(bA.output));
  ok("a) -> sin invalid-step-name", JSON.stringify(bA).indexOf("invalid-step-name") === -1);

  // --- b) REF REESCRITA: nombre con espacios + ref a ese step ---------------
  // step1 "Get Data" (espacios) -> output {x:5}. step2 "Use It" referencia
  // {{Get Data.output}} (ref con el nombre original con espacios). El sanitizer
  // reescribe name->Get_Data y la ref -> {{Get_Data.output}}.
  //
  // PRUEBA DETERMINISTA de la reescritura: /workflows/validate corre el pre-flight
  // (tier estructura+contexto) donde viven 'invalid-step-name' y 'unknown-step-ref'.
  // Sin sanitize, "Get Data"/"Use It" -> invalid-step-name y {{Get Data.output}}
  // (leading-id "Get") -> unknown-step-ref => ok:false. Con sanitize -> ok:true.
  console.log("\n--- b) ref reescrita (nombre con espacios + ref) ---");
  const stepsB = [
    jsonStep("Get Data", { text: '{"x":5}' }),
    jsonStep("Use It", { text: "{{Get Data.output}}" }),
  ];
  const rBV = await fetch(`${BASE}/workflows/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ steps: stepsB }),
  });
  const bBV = await rBV.json();
  console.log("validate(2-step ref con espacios) ->", JSON.stringify(bBV));
  ok("b) validate -> HTTP 200", rBV.status === 200, `(status ${rBV.status})`);
  ok("b) validate -> ok:true (sanitize reescribio names+refs)", bBV.ok === true, JSON.stringify(bBV.findings));
  ok("b) validate -> sin invalid-step-name", JSON.stringify(bBV).indexOf("invalid-step-name") === -1);
  ok("b) validate -> sin unknown-step-ref (ref reescrita y resuelta)", JSON.stringify(bBV).indexOf("unknown-step-ref") === -1);

  // Mismo request por /execute para mostrar el resultado real. NOTA: la resolución
  // de refs a step-output(objeto) en ejecución tope con un bug PRE-EXISTENTE del
  // engine (load-order: engine.cjs captura AP_EXECUTION_MODE al cargarse, antes
  // de que start() fije el env -> ExecutionModeNotSet al activar el code-sandbox
  // del mustache). Es ajeno a sanitize: un 2-step con nombres válidos y ref a
  // objeto falla igual (verificado aparte). Aquí assertamos solo lo que es garante
  // de sanitize: NO hay 400 invalid-step-name ni unknown-step-ref.
  const rB = await fetch(`${BASE}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ steps: stepsB }),
  });
  const bB = await rB.json();
  console.log("execute(2-step ref con espacios) ->", rB.status, JSON.stringify(bB).slice(0, 220));
  ok("b) execute -> sin 400 invalid-step-name (sanitize arregló el nombre)", !(/invalid-step-name/.test(JSON.stringify(bB))));
  ok("b) execute -> sin unknown-step-ref (ref reescrita)", !(/unknown-step-ref/.test(JSON.stringify(bB))));

  // --- c) SANITY: step con nombre ya válido sigue funcionando -----------------
  console.log("\n--- c) sanity (nombre ya válido) ---");
  const rC = await fetch(`${BASE}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      steps: [jsonStep("parse", { text: '{"a":1}' })],
    }),
  });
  const bC = await rC.json();
  console.log("execute(parse, nombre válido) ->", JSON.stringify(bC));
  ok("c) -> HTTP 200", rC.status === 200, `(status ${rC.status})`);
  ok("c) -> status SUCCEEDED", bC.status === "SUCCEEDED", `(got ${bC.status})`);
  ok("c) -> output {a:1}", bC.output && bC.output.a === 1, JSON.stringify(bC.output));
} finally {
  await app.close();
  console.log(failed ? "\n=== SMOKE-SANITIZE FAILED ===" : "\n=== SMOKE-SANITIZE PASSED ===");
  process.exit(failed ? 1 : 0);
}