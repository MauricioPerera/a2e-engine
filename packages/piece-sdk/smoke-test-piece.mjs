// smoke-test-piece — SMOKE del HARNESS testPiece.
// Demuestra que testPieceAction corre la action real via el engine y caza output
// esperado vs no. Piezas demo: piece-json (convert_text_to_json) SIN connection, y
// piece-echo-auth (whoami) CON connection (rama auth via mock).
//
// Uso:  tsx smoke-test-piece.mjs   (debe correrse con tsx)
// Sale 0 si los casos esperados pasan como se predijo (pass pasa, fail NO pasa).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { testPieceAction } from "./src/test-piece.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSON_PIECES = path.resolve(__dirname, "..", "engine-adapter", "custom-pieces");
const ECHO_PIECES = path.resolve(__dirname, "..", "engine-adapter", "custom-pieces-echo", "dist");

function show(title, { results, summary }) {
  console.log(`\n=== ${title} ===`);
  for (const line of summary.lines) console.log(line);
  for (const r of results) {
    console.log(`  ${r.name}: passed=${r.passed} status=${r.status ?? "?"}${r.error ? " error=" + r.error : ""}`);
  }
  console.log(`summary: ${summary.passed}/${summary.total} passed, ${summary.failed} failed`);
}

let ok = true;

// --- piece-json: convert_text_to_json ---
// a) PASS: input {text:'{"a":1}'} -> output {a:1}, expect {a:1}.
// b) FAIL deliberado: mismo input, expect {a:2} -> mismatch real en output.a.
// c) expectStatus SUCCEEDED sin expect -> pasa por status.
const jsonRes = await testPieceAction({
  piecesPath: JSON_PIECES,
  pieceName: "@activepieces/piece-json",
  pieceVersion: "0.1.8",
  cases: [
    { name: "json-pass", actionName: "convert_text_to_json", input: { text: '{"a":1}' }, expect: { a: 1 } },
    { name: "json-fail-expect-a2", actionName: "convert_text_to_json", input: { text: '{"a":1}' }, expect: { a: 2 } },
    { name: "json-status-only", actionName: "convert_text_to_json", input: { text: '{"a":1}' }, expectStatus: "SUCCEEDED" },
  ],
});
show("piece-json convert_text_to_json", jsonRes);

// Auditar el caso pass: mostrar el output REAL que el engine devolvio.
const passOut = JSON.stringify(jsonRes.results[0]);
const failRes = jsonRes.results[1];
console.log(`\n[audit] json-pass output real del engine: ${passOut}`);
console.log(`[audit] json-fail mismatches reales: ${JSON.stringify(failRes.mismatches)}`);

// Predicciones: pass=true, fail=false (con mismatch en output.a), status-only=true.
const a = jsonRes.results[0].passed;
const b = !jsonRes.results[1].passed && jsonRes.results[1].mismatches.some((m) => m.includes("output.a"));
const c = jsonRes.results[2].passed;
console.log(`\n[pred] json-pass passed=true? ${a}`);
console.log(`[pred] json-fail passed=false Y mismatch en output.a? ${b}`);
console.log(`[pred] json-status-only passed=true? ${c}`);
if (!a || !b || !c) {
  console.error("SMOKE piece-json: prediccion NO cumplida");
  ok = false;
}

// --- piece-echo-auth: whoami CON connection (rama auth via mock) ---
// Demuestra la rama connection del harness: el engine resuelve la credencial sobre
// HTTP al mock, la inyecta en context.auth, y la piece devuelve apiKeyTail="1234".
// Requiere que piece-echo-auth este bundleada en custom-pieces-echo/dist
// (node engine-adapter/build-piece-echo.mjs). Si no lo esta, se salta con aviso.
import fs from "node:fs";
const echoBundle = path.join(
  ECHO_PIECES,
  "pieces/@automators/piece-echo-auth-0.1.0/node_modules/@automators/piece-echo-auth/index.cjs",
);
if (!fs.existsSync(echoBundle)) {
  console.log("\n=== piece-echo-auth whoami (connection): SKIPPED — bundle no construido ===");
  console.log("(para habilitarlo: cd engine-adapter && node build-piece-echo.mjs)");
} else {
  const echoRes = await testPieceAction({
    piecesPath: ECHO_PIECES,
    pieceName: "@automators/piece-echo-auth",
    pieceVersion: "0.1.0",
    cases: [
      {
        name: "echo-whoami-auth",
        actionName: "whoami",
        input: { auth: "{{connections['my-echo-conn']}}" },
        expect: { receivedSecret: true, apiKeyTail: "1234" },
      },
    ],
    connection: {
      externalId: "my-echo-conn",
      projectId: "demo-project",
      value: { type: "SECRET_TEXT", secret_text: "sk-test-ABCD1234" },
      pieceName: "@automators/piece-echo-auth",
      displayName: "Echo Auth Connection",
    },
  });
  show("piece-echo-auth whoami (connection via mock)", echoRes);
  console.log(`[audit] echo-whoami output real: ${JSON.stringify(echoRes.results[0])}`);
  const d = echoRes.results[0].passed;
  console.log(`\n[pred] echo-whoami-auth passed=true? ${d}`);
  if (!d) {
    console.error("SMOKE echo-auth: prediccion NO cumplida");
    ok = false;
  }
}

console.log(`\nSMOKE RESULT: ${ok ? "OK" : "FAIL"}`);
process.exit(ok ? 0 : 1);