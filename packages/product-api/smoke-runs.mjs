// smoke-runs.mjs — e2e del run-history (OKF + git por run) sobre product-api.
//
// Arranca el product-api IN-PROCESS con RUNS_REPO en un dir temporal, dispara:
//   - POST /execute exitoso  (piece-json)        -> run SUCCEEDED
//   - POST /execute fallido  (piece inexistente) -> run FAILED (con error)
// y verifica:
//   - se crearon run-*.md en RUNS_REPO/runs/<date>/
//   - el run fallido tiene status FAILED + error en el frontmatter
//   - hay commits en el repo de runs (git log --oneline)
//   - GET /runs responde (fechas + runs)
//   - GET /runs/:date/:runId devuelve el markdown del run
// Limpia el temp dir y mata el server al final.
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// RUNS_REPO y PORT se setean ANTES del import dinámico de index.ts, porque
// handlers.ts lee RUNS_REPO al cargar el módulo.
const RUNS_REPO = mkdtempSync(path.join(os.tmpdir(), "ap-runs-"));
process.env.RUNS_REPO = RUNS_REPO;
process.env.PORT = "8107";

const { start, PRODUCT_PORT } = await import("./src/index.ts");
const BASE = `http://localhost:${PRODUCT_PORT}`;

let failed = false;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};

function git(args) {
  return execFileSync("git", ["-C", RUNS_REPO, ...args], { encoding: "utf8" }).trim();
}

const app = await start();
try {
  // 1) POST /execute exitoso
  const r1 = await fetch(`${BASE}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      steps: [
        {
          name: "parse",
          pieceName: "@activepieces/piece-json",
          pieceVersion: "0.1.8",
          actionName: "convert_text_to_json",
          input: { text: '{"a":1}' },
        },
      ],
    }),
  });
  const b1 = await r1.json();
  console.log("execute(ok) ->", JSON.stringify(b1));
  ok("POST /execute ok -> 200", r1.status === 200, `(status ${r1.status})`);
  ok("ok status SUCCEEDED", b1.status === "SUCCEEDED", `(got ${b1.status})`);

  // 2) POST /execute fallido: piece inexistente -> executeFlow lanza -> 500 + run FAILED
  const r2 = await fetch(`${BASE}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      steps: [
        {
          name: "boom",
          pieceName: "@activepieces/piece-does-not-exist",
          pieceVersion: "0.0.1",
          actionName: "noop",
          input: {},
        },
      ],
    }),
  });
  const b2 = await r2.json();
  console.log("execute(fail) ->", JSON.stringify(b2).slice(0, 160), "...");
  // El engine envuelve piece-not-found en verdict FAILED (no lanza): handleExecute
  // responde 200 con body.status FAILED, y el run se registra como FAILED.
  ok("POST /execute fail -> 200 + status FAILED", r2.status === 200 && b2.status === "FAILED", `(status ${r2.status}, body ${b2.status})`);

  // 3) run-*.md creados
  const today = new Date().toISOString().slice(0, 10);
  const dayDir = path.join(RUNS_REPO, "runs", today);
  let runFiles = [];
  try {
    runFiles = readdirSync(dayDir).filter((f) => /^run-.*\.md$/.test(f));
  } catch (e) {
    /* dir missing */
  }
  ok("run-*.md created (>=2)", runFiles.length >= 2, `(found ${runFiles.length})`);
  console.log("--- run files ---", runFiles);

  // 4) localizar el run FAILED y leer su frontmatter
  let failedRun = null;
  for (const f of runFiles) {
    const content = readFileSync(path.join(dayDir, f), "utf8");
    const fmEnd = content.indexOf("\n---\n", 3);
    const fm = content.slice(0, fmEnd + 4);
    if (/^status: FAILED/m.test(fm)) {
      failedRun = { file: f, content, fm };
    }
  }
  ok("FAILED run found", !!failedRun, failedRun ? failedRun.file : "(none)");
  if (failedRun) {
    console.log("--- FAILED run frontmatter ---");
    console.log(failedRun.fm.trim());
    ok("FAILED frontmatter has error:", /error:\s*.+/m.test(failedRun.fm) && !/^error:\s*$/m.test(failedRun.fm), "");
  }

  // 5) git log del repo de runs
  let log = "";
  try {
    log = git(["log", "--oneline"]);
  } catch (e) {
    log = `(git log failed: ${e.message})`;
  }
  console.log("--- git log --oneline (runs repo) ---");
  console.log(log);
  const commitCount = log ? log.split("\n").length : 0;
  ok("git commits >= 2", commitCount >= 2, `(commits ${commitCount})`);

  // 6) GET /runs
  const gr = await fetch(`${BASE}/runs`);
  const rb = await gr.json();
  console.log("--- GET /runs ---");
  console.log(JSON.stringify(rb, null, 2));
  ok("GET /runs -> 200", gr.status === 200, `(status ${gr.status})`);
  ok("GET /runs lists runs (>=2)", Array.isArray(rb.runs) && rb.runs.length >= 2, `(runs ${rb?.runs?.length})`);

  // 7) GET /runs/:date/:runId (usar el run fallido)
  if (failedRun) {
    const runId = failedRun.file.replace(/^run-/, "").replace(/\.md$/, "");
    const gr2 = await fetch(`${BASE}/runs/${today}/${runId}`);
    const md = await gr2.text();
    console.log("--- GET /runs/:date/:runId (FAILED) ---");
    console.log(md.split("\n").slice(0, 14).join("\n"));
    ok("GET /runs/:date/:runId -> 200", gr2.status === 200, `(status ${gr2.status})`);
    ok("returned markdown has FAILED", /status: FAILED/.test(md), "");
  } else {
    ok("GET /runs/:date/:runId (skipped, no failed run)", false, "");
  }
} finally {
  await app.close();
  try {
    rmSync(RUNS_REPO, { recursive: true, force: true });
  } catch (e) {
    console.error("cleanup failed:", e.message);
  }
  console.log(failed ? "\n=== SMOKE-RUNS FAILED ===" : "\n=== SMOKE-RUNS PASSED ===");
  process.exit(failed ? 1 : 0);
}