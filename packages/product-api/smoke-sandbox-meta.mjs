// SMOKE-SANDBOX-META — verifica que el require+.metadata() de pieces NO
// confiables corre DENTRO del sandbox bwrap (vector cerrado), no in-process.
//
// (a) LEGITIMO (piece-json) con T2_SANDBOX=1:
//     buildSelectedPieces -> el bundle Y el require+.metadata() corren DENTRO
//     del sandbox (sandbox-build.sh modo "process" -> sandbox-process.mjs).
//     Confirma: metadata.json producido con name/displayName/actions; catalogo
//     OKF aislado generado desde ese metadata.json; el bundle carga/ejecuta via
//     AP_CUSTOM_PIECES_PATHS=outRoot (json.convert_text_to_json -> SUCCEEDED).
//
// (b) MALICIOSA EN METADATA: piece sintetica cuyo src/index.ts ejecuta AL CARGAR
//     EL MODULO (top-level, lo que corre en require/.metadata()):
//       (i)   fetch('https://example.com')            -> red (debe fallar en sandbox)
//       (ii)  fs.readFileSync('/home/administrador/SECRET.txt')  -> host secret
//       (iii) readFileSync('/home/administrador/.ssh/id_rsa'), '/etc/shadow'
//     Se procesa con T2_SANDBOX=1 via buildPieceSandboxed (sandbox-build.sh modo
//     "process"). El require+.metadata() corre DENTRO del sandbox:
//       - red bloqueada -> FETCH_FAIL
//       - host FS no bind-eado -> READ_FAIL ... ENOENT (incluido SECRET.txt)
//       - el HOST nunca hace require del bundle: si lo hiciera, leeria SECRET.txt
//         (el host SI lo tiene) y loguearia READ_OK TOPSECRET. Como loguea
//         READ_FAIL ENOENT, el require corrio en el sandbox (sin SECRET), no host.
//       - TOPSECRET no aparece en outRoot (metadata.json, attack.log, ningun archivo).
//     Limpia SECRET.txt y temps.
//
// Correr: npx tsx smoke-sandbox-meta.mjs
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync,
} from "node:fs";
import { buildSelectedPieces, buildPieceSandboxed } from "../piece-source-manager/src/build-source.ts";

const require = createRequire(import.meta.url);
const HOME = os.homedir();
const AP_ROOT = path.join(HOME, "ap");
const SECRET_FILE = path.join(HOME, "SECRET.txt");
const JSON_META_REL = "pieces/@activepieces/piece-json-0.1.8/node_modules/@activepieces/piece-json/metadata.json";

let failed = false;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};

// =========================================================================
// (a) LEGITIMO: build+metadata de json EN sandbox (T2_SANDBOX=1)
// =========================================================================
console.log("=== (a) build+metadata de piece-json EN sandbox (T2_SANDBOX=1) ===");
process.env.T2_SANDBOX = "1";
const aOut = mkdtempSync(path.join(os.tmpdir(), "sbxmeta-a-out-"));
const aCat = mkdtempSync(path.join(os.tmpdir(), "sbxmeta-a-cat-"));
try {
  const res = await buildSelectedPieces({
    sourceDir: AP_ROOT,
    pieceNames: ["@activepieces/piece-json"],
    outRoot: aOut,
    catalogOut: aCat,
  });
  ok("piece-json bundleada+metadata en sandbox",
    res.built.some((b) => b.name === "@activepieces/piece-json"),
    `(built=${JSON.stringify(res.built.map((b) => b.name))})`);

  const metaPath = path.join(aOut, JSON_META_REL);
  ok("metadata.json producido por el sandbox", existsSync(metaPath), `(${metaPath})`);
  let meta = null;
  if (existsSync(metaPath)) {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
    ok("metadata.name = @activepieces/piece-json",
      meta.name === "@activepieces/piece-json", `(${meta.name})`);
    ok("metadata.displayName = JSON", meta.displayName === "JSON", `(${meta.displayName})`);
    ok("metadata.actions no vacio",
      Object.keys(meta.actions || {}).length > 0,
      `(actions=${Object.keys(meta.actions || {}).join(",")})`);
    ok("metadata sin TOPSECRET (sanity)", !JSON.stringify(meta).includes("TOPSECRET"));
  }

  // Catalogo OKF aislado generado desde el metadata.json del sandbox.
  const indexMd = path.join(res.catalogPath, "index.md");
  ok("catalogo aislado: index.md generado", existsSync(indexMd));
  const indexText = existsSync(indexMd) ? readFileSync(indexMd, "utf8") : "";
  ok("catalogo aislado lista piece-json", /piece-json/.test(indexText));

  // El bundle (producido en sandbox) carga/ejecuta via AP_CUSTOM_PIECES_PATHS=outRoot.
  console.log("\n=== executeFlow (AP_CUSTOM_PIECES_PATHS=aOut) ===");
  process.env.AP_CUSTOM_PIECES_PATHS = aOut;
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
  ok("json -> SUCCEEDED (bundle del sandbox carga/ejecuta)", step1?.status === "SUCCEEDED",
    `(got ${step1?.status})`);
  ok("json -> output {a:1}", step1?.output && step1.output.a === 1, JSON.stringify(step1?.output));
} finally {
  rmSync(aOut, { recursive: true, force: true });
  rmSync(aCat, { recursive: true, force: true });
}

// =========================================================================
// (b) MALICIOSA EN METADATA: require+.metadata() corre DENTRO del sandbox
// =========================================================================
console.log("\n=== (b) piece maliciosa en metadata (red + host secret) T2_SANDBOX=1 ===");
const evilSrc = mkdtempSync(path.join(os.tmpdir(), "sbxmeta-evil-src-"));
const evilDir = path.join(evilSrc, "piece-malicious");
const evilOut = mkdtempSync(path.join(os.tmpdir(), "sbxmeta-evil-out-"));
mkdirSync(path.join(evilDir, "src"), { recursive: true });
writeFileSync(path.join(evilDir, "package.json"),
  JSON.stringify({ name: "@evil/piece-malicious", version: "0.0.1" }, null, 2));
// Codigo malicioso: ataques a nivel de MODULO (corren al require del bundle, que
// ahora ocurre DENTRO del sandbox via sandbox-process.mjs). El .catch de fetch
// registra FETCH_FAIL; el Wasm OOM de undici (side-effect del ulimit -v) queda
// como unhandledRejection contenido por sandbox-process.mjs (log, no crash).
writeFileSync(path.join(evilDir, "src/index.ts"),
`import fs from 'fs';
import path from 'path';

const LOG = path.join(__dirname, 'attack.log');
function log(s: string) { try { fs.appendFileSync(LOG, s + '\\n'); } catch {} }

// (ii) host secret (sync) — corre al cargar el modulo
try {
  const s = fs.readFileSync('/home/administrador/SECRET.txt', 'utf8');
  log('READ_OK SECRET=' + s.slice(0, 40));
} catch (e: any) {
  log('READ_FAIL SECRET ' + (e.code || e.message));
}
// (iii) otros archivos del host
for (const p of ['/home/administrador/.ssh/id_rsa', '/etc/shadow']) {
  try { const s = fs.readFileSync(p, 'utf8'); log('READ_OK ' + p + '=' + s.slice(0, 20)); }
  catch (e: any) { log('READ_FAIL ' + p + ' ' + (e.code || e.message)); }
}
// (i) red (async) — registra resultado cuando settle
try {
  fetch('https://example.com')
    .then((r: any) => log('FETCH_OK status=' + r.status))
    .catch((e: any) => log('FETCH_FAIL ' + (e && e.message ? e.message : String(e))));
} catch (e: any) {
  log('FETCH_THROW ' + (e && e.message ? e.message : String(e)));
}

export const createPiece: any = () => ({});
createPiece.metadata = () => ({
  name: '@evil/piece-malicious',
  displayName: 'Malicious',
  description: 'evil test piece',
  version: '0.0.1',
  actions: {},
  triggers: {},
});
export default createPiece;
`);
// host secret real (se limpia al final). Si el HOST hiciera require del bundle,
// leeria este archivo -> READ_OK TOPSECRET. El sandbox no lo tiene bind-eado.
writeFileSync(SECRET_FILE, "TOPSECRET");

try {
  // Procesa la piece maliciosa con T2_SANDBOX=1: el require+.metadata() corre
  // DENTRO del sandbox (sandbox-build.sh modo "process"). El host solo lee
  // metadata.json (datos); NUNCA require del bundle.
  const r = await buildPieceSandboxed(evilDir, evilOut);
  ok("sandbox procesa piece maliciosa (exit OK, metadata.json producido)",
    existsSync(path.join(r.pkgDir, "metadata.json")));
  ok("host leyo metadata.json (name=@evil/piece-malicious)",
    r.metadata && r.metadata.name === "@evil/piece-malicious",
    `(${r.metadata?.name})`);

  const attackLog = path.join(r.pkgDir, "attack.log");
  ok("attack.log escrito (el top-level corrio en algun lado)", existsSync(attackLog));
  const log = existsSync(attackLog) ? readFileSync(attackLog, "utf8") : "";
  console.log("--- attack.log ---");
  console.log(log.trim() || "(vacio)");

  // Red bloqueada dentro del sandbox.
  ok("malicious: red bloqueada (FETCH_FAIL)", /FETCH_FAIL/.test(log),
    `(${(log.match(/FETCH_[A-Z]+/g) || ["none"])[0]})`);
  ok("malicious: sin FETCH_OK", !/FETCH_OK/.test(log));
  // Host FS no bind-eado -> ENOENT. SECRET.txt ENOENT prueba que el require
  // corrio en el sandbox (no host): el host TIENE SECRET.txt.
  ok("malicious: SECRET.txt ENOENT (require corrio en sandbox, no host)",
    /READ_FAIL\s+SECRET\s+ENOENT/.test(log),
    `(${(log.match(/READ_FAIL\s+SECRET[^\n]*/g) || ["none"])[0]})`);
  ok("malicious: .ssh/id_rsa ENOENT",
    /READ_FAIL\s+\/home\/administrador\/\.ssh\/id_rsa\s+ENOENT/.test(log));
  ok("malicious: /etc/shadow ENOENT",
    /READ_FAIL\s+\/etc\/shadow\s+ENOENT/.test(log));
  ok("malicious: ningun READ_OK (ningun host file leido)", !/READ_OK/.test(log));

  // TOPSECRET no aparece en attack.log ni en metadata.json.
  ok("malicious: TOPSECRET ausente de attack.log", !log.includes("TOPSECRET"));
  const metaJson = readFileSync(path.join(r.pkgDir, "metadata.json"), "utf8");
  ok("malicious: TOPSECRET ausente de metadata.json", !metaJson.includes("TOPSECRET"));

  // TOPSECRET ausente de todo outRoot.
  let topInOut = false;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (readFileSync(p, "utf8").includes("TOPSECRET")) topInOut = true;
    }
  };
  walk(evilOut);
  ok("malicious: TOPSECRET ausente de todo outRoot", !topInOut,
    topInOut ? "(TOPSECRET encontrado en out!)" : "(ausente)");

  // Host intacto: SECRET.txt sigue siendo TOPSECRET (no fue leido/tocado por el
  // proceso host; el sandbox lo vio ENOENT).
  ok("host intacto: SECRET.txt sigue = TOPSECRET",
    readFileSync(SECRET_FILE, "utf8").trim() === "TOPSECRET");
} finally {
  rmSync(evilSrc, { recursive: true, force: true });
  rmSync(evilOut, { recursive: true, force: true });
  try { fs.unlinkSync(SECRET_FILE); } catch {}
}

console.log(failed ? "\n=== SMOKE-SANDBOX-META FAILED ===" : "\n=== SMOKE-SANDBOX-META PASSED ===");
process.exit(failed ? 1 : 0);