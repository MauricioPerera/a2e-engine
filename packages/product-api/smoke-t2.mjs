// SMOKE T2 — flujo piece source manager: repo -> select -> validate -> bundle ->
// catalogo OKF aislado -> pieces cargan y ejecutan.
//
// Selecciona [piece-json, piece-flow-helper, piece-does-not-exist] de ~/ap,
// buildSelectedPieces (valida -> bundlea solo validas -> genera catalogo aislado),
// muestra built/rejected + el index.md del catalogo aislado, y luego CARGA las
// pieces bundleadas via AP_CUSTOM_PIECES_PATHS=outRoot y ejecuta
// json.convert_text_to_json input {a:1} -> SUCCEEDED {a:1}.
//
// HECHO REAL: piece-flow-helper NO pasa validacion (error:short-description —
// su createPiece no declara description). Con validate=true (default) es rejected
// y NO se bundlea; el catalogo aislado lista solo json. El name inexistente ->
// rejected not-found. Limpia temps al final.
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { buildSelectedPieces } from "../piece-source-manager/src/build-source.ts";

const require = createRequire(import.meta.url);
const AP_ROOT = path.join(os.homedir(), "ap");

let failed = false;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};

const NAMES = [
  "@activepieces/piece-json",
  "@activepieces/piece-flow-helper",
  "@activepieces/piece-does-not-exist",
];

const outRoot = mkdtempSync(path.join(os.tmpdir(), "t2-out-"));
const catalogOut = mkdtempSync(path.join(os.tmpdir(), "t2-cat-"));

console.log("=== buildSelectedPieces ===");
console.log(`sourceDir=${AP_ROOT}`);
console.log(`outRoot=${outRoot}`);
console.log(`catalogOut=${catalogOut}`);
console.log(`select=${JSON.stringify(NAMES)}`);

const res = await buildSelectedPieces({
  sourceDir: AP_ROOT,
  pieceNames: NAMES,
  outRoot,
  catalogOut,
});

console.log("\n--- built ---");
console.log(JSON.stringify(res.built, null, 2));
console.log("\n--- rejected ---");
console.log(JSON.stringify(res.rejected, null, 2));

const builtNames = res.built.map((b) => b.name);
ok("piece-json bundleada (valida)", builtNames.includes("@activepieces/piece-json"));
ok("piece-does-not-exist -> rejected not-found",
  res.rejected.some((r) => r.name === "@activepieces/piece-does-not-exist" && r.reason === "not-found"));
// flow-helper: con validate=true es rejected (error:short-description, real).
const fhRejected = res.rejected.find((r) => r.name === "@activepieces/piece-flow-helper");
if (fhRejected) {
  ok("piece-flow-helper -> rejected (error:short-description, real)",
    fhRejected.reason === "validation-failed" && fhRejected.findings?.some((f) => f.code === "short-description"),
    `(reason=${fhRejected.reason})`);
} else {
  // Si en el futuro flow-helper declara description, seria built (validacion ok|warns).
  ok("piece-flow-helper bundleada (validacion ok|warns)", builtNames.includes("@activepieces/piece-flow-helper"));
}

// Catalogo OKF aislado: index.md existe y lista json (y flow-helper si llego a built).
const indexMd = path.join(res.catalogPath, "index.md");
ok("catalogo aislado: index.md generado", existsSync(indexMd));
const indexText = existsSync(indexMd) ? readFileSync(indexMd, "utf8") : "";
console.log("\n--- catalogo aislado: index.md ---");
console.log(indexText || "(no index.md)");
ok("catalogo aislado lista piece-json", /piece-json|@activepieces\/piece-json/.test(indexText));

// CARGA + EJECUTA: AP_CUSTOM_PIECES_PATHS=outRoot + executeFlow json convert_text_to_json.
console.log("\n=== executeFlow (AP_CUSTOM_PIECES_PATHS=outRoot) ===");
process.env.AP_CUSTOM_PIECES_PATHS = outRoot;
const { executeFlow } = require("../engine-adapter/src/execute-flow.cjs");

const action = {
  name: "step1",
  valid: true,
  displayName: "convert_text_to_json",
  lastUpdatedDate: new Date().toISOString(),
  type: "PIECE",
  settings: {
    pieceName: "@activepieces/piece-json",
    pieceVersion: "0.1.8",
    actionName: "convert_text_to_json",
    input: { text: { a: 1 } },
    propertySettings: { text: {} },
    errorHandlingOptions: undefined,
  },
  nextAction: undefined,
};

let execResult = null;
try {
  execResult = await executeFlow({ action, port: process.env.PORT || "3997" });
} catch (e) {
  console.log("executeFlow threw:", e && e.message ? e.message : String(e));
}
const step1 = execResult?.steps?.["step1"];
console.log("execute(json) ->", JSON.stringify(step1));
ok("json -> SUCCEEDED", step1?.status === "SUCCEEDED", `(got ${step1?.status})`);
ok("json -> output {a:1}", step1?.output && step1.output.a === 1, JSON.stringify(step1?.output));

// Limpia temps.
rmSync(outRoot, { recursive: true, force: true });
rmSync(catalogOut, { recursive: true, force: true });
console.log("\ntemps limpiados");

console.log(failed ? "\n=== SMOKE-T2 FAILED ===" : "\n=== SMOKE-T2 PASSED ===");
process.exit(failed ? 1 : 0);