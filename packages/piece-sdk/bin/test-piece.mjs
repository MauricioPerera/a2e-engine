// CLI test-piece: <piecesPath> <pieceName> <pieceVersion> <cases.json>
// Corre testPieceAction contra los casos y imprime summary.lines.
// Exit 1 si algun caso fallo, 0 si todos pasaron.
//
// Uso (debe correrse con tsx para poder importar el .ts):
//   tsx bin/test-piece.mjs <piecesPath> <pieceName> <pieceVersion> <cases.json>
//
// cases.json: array de TestCase { name, actionName, input, expect?, expectStatus? }.
// Este CLI NO soporta connection (uso programatico via testPieceAction para auth).

import { testPieceAction } from "../src/test-piece.ts";

const [, , piecesPath, pieceName, pieceVersion, casesFile] = process.argv;

function usage() {
  console.error("usage: tsx bin/test-piece.mjs <piecesPath> <pieceName> <pieceVersion> <cases.json>");
  process.exit(2);
}
if (!piecesPath || !pieceName || !pieceVersion || !casesFile) usage();

let cases;
try {
  const fs = await import("node:fs");
  const raw = fs.readFileSync(casesFile, "utf-8");
  cases = JSON.parse(raw);
} catch (e) {
  console.error(`could not read/parse cases file "${casesFile}":`, e instanceof Error ? e.message : e);
  process.exit(2);
}
if (!Array.isArray(cases) || cases.length === 0) {
  console.error("cases file must be a non-empty array of TestCase");
  process.exit(2);
}

try {
  const { summary, results } = await testPieceAction({ piecesPath, pieceName, pieceVersion, cases });
  for (const line of summary.lines) console.log(line);
  console.log(`-- summary: ${summary.passed}/${summary.total} passed, ${summary.failed} failed`);
  // Detalle de output por caso (auditable: muestra el output REAL del engine).
  for (const r of results) {
    const out = r.passed ? "" : "";
    console.log(`[${r.passed ? "PASS" : "FAIL"}] ${r.name} status=${r.status ?? "?"}${out}`);
  }
  process.exit(summary.failed > 0 ? 1 : 0);
} catch (e) {
  console.error("harness error:", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(3);
}