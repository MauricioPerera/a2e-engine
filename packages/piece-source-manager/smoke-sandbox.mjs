// SMOKE-SANDBOX — verifica el sandbox de build T2 (bwrap) end-to-end.
//
// (a) BUILD LEGITIMO: bundlea piece-json DENTRO del sandbox (sandbox-build.sh,
//     el wrapper que build-source.ts usa con T2_SANDBOX=1) y compara el
//     index.cjs con el baseline in-process (mismo esbuild, mismos aliases).
//     Deben ser byte-identicos.
// (b) PIECE MALICIOSA: piece sintetica cuyo src/index.ts, al ejecutarse, hace:
//       (i)  fetch('https://example.com')  -> red (debe fallar en el sandbox)
//       (ii) fs.readFileSync('/home/administrador/SECRET.txt')  -> host secret
//            (debe dar ENOENT: no esta bind-eado)
//       (iii) readFileSync('/home/administrador/.ssh/id_rsa') y '/etc/shadow'
//            (idem, no bind-eados)
//     Se bundlea DENTRO del sandbox (esbuild no ejecuta el codigo) y luego se
//     EJECUTA el bundle DENTRO de un sandbox bwrap con el mismo confinamiento.
//     Confirma: FETCH_FAIL, SECRET/ssh/shadow -> ENOENT, y 'TOPSECRET' no
//     aparece en outRoot (la piece intenta exfiltrar escribiendo a outRoot).
// Limpia SECRET.txt y todos los temps al final.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";

const HOME = os.homedir();
const AP_ROOT = path.join(HOME, "ap");
const PSM = path.join(HOME, "product/packages/piece-source-manager");
const SANDBOX = path.join(PSM, "scripts/sandbox-build.sh");
const NODE = "/home/administrador/.hermes/node/bin/node";
const BUILD_PIECE = path.join(HOME, "product/packages/engine-adapter/build-piece.mjs");
const JSON_PIECE = path.join(AP_ROOT, "packages/pieces/community/json");
const JSON_REL = "pieces/@activepieces/piece-json-0.1.8/node_modules/@activepieces/piece-json";

let failed = false;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};
const sha = (f) => crypto.createHash("sha256").update(readFileSync(f)).digest("hex");

// bwrap bind set comun para la EJECUCION del bundle malicioso (mismo confinamiento
// que sandbox-build.sh, sin AP ni la piece dir: solo node + libc + outRoot RW).
function bwrapExecArgs(evilOut, cmd, cmdArgs) {
  return [
    "--unshare-all", "--die-with-parent", "--clearenv",
    "--setenv", "PATH", "/home/administrador/.hermes/node/bin:/usr/bin:/bin",
    "--setenv", "HOME", "/tmp",
    "--setenv", "OUT_ROOT", evilOut,
    "--ro-bind", "/home/administrador/.hermes/node", "/home/administrador/.hermes/node",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--symlink", "usr/bin", "/bin",
    "--tmpfs", "/tmp",
    "--bind", evilOut, evilOut,
    "--dev", "/dev",
    "--proc", "/proc",
    "--", NODE, cmd, ...cmdArgs,
  ];
}

// =========================================================================
// (a) BUILD LEGITIMO en sandbox
// =========================================================================
console.log("=== (a) build legitimo (piece-json) en sandbox ===");
const outBase = mkdtempSync(path.join(os.tmpdir(), "sbx-base-"));
const outSbx = mkdtempSync(path.join(os.tmpdir(), "sbx-sandbox-"));
try {
  const base = spawnSync(NODE, [BUILD_PIECE, JSON_PIECE, outBase], { encoding: "utf8", cwd: JSON_PIECE });
  ok("baseline in-process build OK", base.status === 0, `(status=${base.status})`);
  const baseIdx = path.join(outBase, JSON_REL, "index.cjs");
  ok("baseline index.cjs existe", existsSync(baseIdx));
  const baseHash = existsSync(baseIdx) ? sha(baseIdx) : "";

  const sbx = spawnSync(SANDBOX, [JSON_PIECE, outSbx], { encoding: "utf8" });
  ok("sandbox-build.sh piece-json OK", sbx.status === 0,
    `(status=${sbx.status}${sbx.stderr ? " stderr=" + sbx.stderr.slice(0, 160) : ""})`);
  const sbxIdx = path.join(outSbx, JSON_REL, "index.cjs");
  ok("sandbox index.cjs existe", existsSync(sbxIdx));
  const sbxHash = existsSync(sbxIdx) ? sha(sbxIdx) : "";
  ok("sandbox bundle == baseline (byte-identico)", baseHash === sbxHash && baseHash !== "",
    `(base=${baseHash.slice(0, 12)} sbx=${sbxHash.slice(0, 12)})`);
} finally {
  rmSync(outBase, { recursive: true, force: true });
  rmSync(outSbx, { recursive: true, force: true });
}

// =========================================================================
// (b) PIECE MALICIOSA
// =========================================================================
console.log("\n=== (b) piece maliciosa (red + host secret) en sandbox ===");
const evilSrc = mkdtempSync(path.join(os.tmpdir(), "sbx-evil-src-"));
const evilDir = path.join(evilSrc, "piece-malicious");
const evilOut = mkdtempSync(path.join(os.tmpdir(), "sbx-evil-out-"));
mkdirSync(path.join(evilDir, "src"), { recursive: true });
writeFileSync(path.join(evilDir, "package.json"),
  JSON.stringify({ name: "@evil/piece-malicious", version: "0.0.1" }, null, 2));
// Codigo malicioso: ataques a nivel de modulo (corren al require del bundle).
// Usa string concat (no template literals) para evitar sorpresas con esbuild.
writeFileSync(path.join(evilDir, "src/index.ts"),
`import fs from 'fs';
import path from 'path';

export async function run() {
  const results: string[] = [];
  // (i) red
  try {
    const r = await fetch('https://example.com');
    results.push('FETCH_OK status=' + r.status);
  } catch (e: any) {
    results.push('FETCH_FAIL ' + (e && e.message ? e.message : String(e)));
  }
  // (ii)/(iii) lectura de archivos del host fuera de su dir
  const targets = ['/home/administrador/SECRET.txt', '/home/administrador/.ssh/id_rsa', '/etc/shadow'];
  for (const p of targets) {
    try {
      const s = fs.readFileSync(p, 'utf8');
      results.push('READ_OK ' + p + ': ' + s.slice(0, 40));
      // exfiltracion por escritura a outRoot (bind RW): si lee el secreto, lo escribe.
      const leak = path.join(process.env.OUT_ROOT || '/tmp', 'leaked-' + path.basename(p));
      try { fs.writeFileSync(leak, s); results.push('LEAK_WROTE ' + leak); }
      catch (we: any) { results.push('LEAK_FAIL ' + (we.code || we.message)); }
    } catch (e: any) {
      results.push('READ_FAIL ' + p + ' ' + (e && e.code ? e.code : e.message));
    }
  }
  return results;
}
`);
// host secret real (se limpia al final).
writeFileSync("/home/administrador/SECRET.txt", "TOPSECRET");

try {
  // bundlea la piece maliciosa DENTRO del sandbox (esbuild no ejecuta el codigo).
  const ebundle = spawnSync(SANDBOX, [evilDir, evilOut], { encoding: "utf8" });
  ok("sandbox-build.sh piece-malicious (bundle) OK", ebundle.status === 0,
    `(status=${ebundle.status}${ebundle.stderr ? " stderr=" + ebundle.stderr.slice(0, 160) : ""})`);
  const evilIdx = path.join(evilOut,
    "pieces/@evil/piece-malicious-0.0.1/node_modules/@evil/piece-malicious/index.cjs");
  ok("malicious index.cjs bundleado en sandbox", existsSync(evilIdx), `(${evilIdx})`);

  // executor: requiere el bundle y llama run(). Lo escribimos a evilOut (bind RW).
  const execPath = path.join(evilOut, "exec.cjs");
  writeFileSync(execPath,
    "const m = require(process.argv[2]);\n" +
    "m.run().then(function(r){ console.log('MALICIOUS_RESULTS=' + JSON.stringify(r)); })\n" +
    ".catch(function(e){ console.log('EXEC_ERR=' + (e && e.message ? e.message : String(e))); process.exit(1); });\n");

  // ejecuta el bundle DENTRO del sandbox bwrap (mismo confinamiento).
  const execRun = spawnSync("bwrap", bwrapExecArgs(evilOut, execPath, [evilIdx]),
    { encoding: "utf8" });
  console.log("--- malicious exec stdout ---");
  console.log((execRun.stdout || "").trim() || "(no stdout)");
  if (execRun.stderr) console.log("stderr:", execRun.stderr.slice(0, 300));
  const out = execRun.stdout || "";

  ok("malicious: red bloqueada (FETCH_FAIL)", /FETCH_FAIL/.test(out),
    `(${(out.match(/FETCH_[A-Z]+/g) || ["none"])[0]})`);
  ok("malicious: SECRET.txt inaccesible (READ_FAIL ENOENT)",
    /READ_FAIL\s+\/home\/administrador\/SECRET\.txt\s+ENOENT/.test(out),
    `(${(out.match(/READ_FAIL\s+\/home\/administrador\/SECRET\.txt[^\n]*/g) || ["none"])[0]})`);
  ok("malicious: .ssh/id_rsa inaccesible (ENOENT)",
    /READ_FAIL\s+\/home\/administrador\/\.ssh\/id_rsa\s+ENOENT/.test(out),
    `(${(out.match(/READ_FAIL\s+\/home\/administrador\/\.ssh[^\n]*/g) || ["none"])[0]})`);
  ok("malicious: /etc/shadow inaccesible (ENOENT)",
    /READ_FAIL\s+\/etc\/shadow\s+ENOENT/.test(out),
    `(${(out.match(/READ_FAIL\s+\/etc\/shadow[^\n]*/g) || ["none"])[0]})`);
  ok("malicious: sin READ_OK (ningun host file leido)", !/READ_OK/.test(out));

  // 'TOPSECRET' NO debe aparecer en ningun archivo de outRoot.
  let topInOut = false;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (readFileSync(p, "utf8").includes("TOPSECRET")) topInOut = true;
    }
  };
  walk(evilOut);
  ok("malicious: 'TOPSECRET' NO aparece en outRoot", !topInOut,
    topInOut ? "(TOPSECRET encontrado en out!)" : "(ausente)");
} finally {
  rmSync(evilSrc, { recursive: true, force: true });
  rmSync(evilOut, { recursive: true, force: true });
  try { fs.unlinkSync("/home/administrador/SECRET.txt"); } catch {}
}

console.log(failed ? "\n=== SMOKE-SANDBOX FAILED ===" : "\n=== SMOKE-SANDBOX PASSED ===");
process.exit(failed ? 1 : 0);