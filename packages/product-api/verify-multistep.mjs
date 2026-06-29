// verify-multistep.mjs — reproduce/verifica el fix de load-order de AP_EXECUTION_MODE.
//
// Ejecuta via product-api (/execute) un flujo de 2 steps con referencia inter-step
// REAL: step2 consume {{s1.output.value}}. Antes del fix en execute-flow.cjs el
// engine capturaba EXECUTION_MODE=undefined al cargar (el require ocurre antes de
// que index.ts setee el env) -> 500 "AP_EXECUTION_MODE ... is not set" desde el
// code-sandbox del mustache. Después del fix -> 200 SUCCEEDED con el output de s2
// usando el valor que produjo s1.
//
// Uso: node verify-multistep.mjs [base-url]
//   base-url default: http://localhost:8080
const BASE = process.argv[2] || "http://localhost:8080";

// step1 "s1": parsea '{"value":7}' -> output { value: 7 }
// step2 "s2": text = "{{s1.output.value}}" -> el engine resuelve la ref inter-step
//   a 7, JSON.parse(7) -> 7. Demuestra que {{s1.output.value}} se resolvió.
const body = {
  steps: [
    {
      name: "s1",
      pieceName: "@activepieces/piece-json",
      pieceVersion: "0.1.8",
      actionName: "convert_text_to_json",
      input: { text: '{"value":7}' },
    },
    {
      name: "s2",
      pieceName: "@activepieces/piece-json",
      pieceVersion: "0.1.8",
      actionName: "convert_text_to_json",
      input: { text: "{{s1.output.value}}" },
    },
  ],
};

const res = await fetch(`${BASE}/execute`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const text = await res.text();
let json;
try {
  json = JSON.parse(text);
} catch {
  json = { _raw: text };
}

const ok = res.status === 200 && json.status === "SUCCEEDED" && json.output === 7;

console.log("HTTP status:", res.status);
console.log("Body:", JSON.stringify(json));
console.log("VERDICT:", ok ? "PASS (inter-step ref resolved; s2 output === 7)" : "FAIL");

process.exit(ok ? 0 : 1);