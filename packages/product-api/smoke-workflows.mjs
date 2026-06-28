// smoke-workflows.mjs — e2e del workflow-registry (OKF + git por workflow) sobre
// product-api. Ejercita el ciclo GUARDAR -> DESCUBRIR -> LEER -> RE-EJECUTAR +
// versionado (2 commits), sobre HTTP real.
//
// Arranca el product-api IN-PROCESS con WORKFLOWS_REPO en un dir temporal:
//   1) POST /workflows            -> { id, version: "v1" }
//   2) GET  /workflows            -> lista el wf con piecesUsed
//   3) GET  /workflows/:id        -> markdown OKF con la Definition (```json)
//   4) POST /workflows/:id/execute -> SUCCEEDED con el output esperado ({a:1})
//   5) Re-POST mismo id (update)  -> version "v2" + 2do commit
//   + GET /workflows?format=okf   -> index.md crudo
//   + git log del repo de workflows (>=2 commits)
// Limpia el temp dir y mata el server al final.
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

// WORKFLOWS_REPO y PORT se setean ANTES del import dinámico de index.ts, porque
// handlers.ts lee WORKFLOWS_REPO al cargar el módulo.
const WORKFLOWS_REPO = mkdtempSync(path.join(os.tmpdir(), "ap-wf-"));
process.env.WORKFLOWS_REPO = WORKFLOWS_REPO;
// Aislamos también RUNS_REPO para no pisar el default del host durante el smoke.
process.env.RUNS_REPO = mkdtempSync(path.join(os.tmpdir(), "ap-wf-runs-"));
process.env.PORT = "8111";

const { start, PRODUCT_PORT } = await import("./src/index.ts");
const BASE = `http://localhost:${PRODUCT_PORT}`;

let failed = false;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};

function git(args) {
  return execFileSync("git", ["-C", WORKFLOWS_REPO, ...args], { encoding: "utf8" }).trim();
}

const WF_ID = "wf-smoke-1";
const jsonStep = {
  name: "parse",
  pieceName: "@activepieces/piece-json",
  pieceVersion: "0.1.8",
  actionName: "convert_text_to_json",
  input: { text: '{"a":1}' },
};

const app = await start();
try {
  // 1) POST /workflows -> guarda, version v1
  const r1 = await fetch(`${BASE}/workflows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: WF_ID, name: "Parse JSON", description: "v1 desc", steps: [jsonStep] }),
  });
  const b1 = await r1.json();
  console.log("POST /workflows ->", JSON.stringify(b1));
  ok("POST /workflows -> 201", r1.status === 201, `(status ${r1.status})`);
  ok("workflow id echoed", b1.id === WF_ID, `(id ${b1.id})`);
  ok("workflow version v1", b1.version === "v1", `(version ${b1.version})`);

  // 2) GET /workflows -> lista el wf con piecesUsed
  const r2 = await fetch(`${BASE}/workflows`);
  const b2 = await r2.json();
  console.log("--- GET /workflows ---");
  console.log(JSON.stringify(b2, null, 2));
  ok("GET /workflows -> 200", r2.status === 200, `(status ${r2.status})`);
  const listed = (b2.workflows ?? []).find((w) => w.id === WF_ID);
  ok("workflow listed", !!listed, listed ? `name=${listed.name}` : "(missing)");
  ok("listed piecesUsed has piece-json", !!listed && listed.piecesUsed.includes("@activepieces/piece-json"), `(${listed?.piecesUsed?.join(",")})`);
  ok("listed stepCount == 1", !!listed && listed.stepCount === 1, `(stepCount ${listed?.stepCount})`);

  // 3) GET /workflows/:id -> markdown OKF con la Definition
  const r3 = await fetch(`${BASE}/workflows/${WF_ID}`);
  const b3 = await r3.json();
  ok("GET /workflows/:id -> 200", r3.status === 200, `(status ${r3.status})`);
  const md = String(b3.markdown ?? "");
  console.log("--- GET /workflows/:id (markdown) ---");
  console.log(md.split("\n").slice(0, 16).join("\n"));
  ok("markdown has # Parse JSON", /# Parse JSON/.test(md), "");
  ok("markdown has Definition fence", /```json/.test(md), "");
  ok("markdown has convert_text_to_json", /convert_text_to_json/.test(md), "");
  ok("record has steps[]", Array.isArray(b3.record?.steps) && b3.record.steps.length === 1, `(steps ${b3.record?.steps?.length})`);

  // 4) POST /workflows/:id/execute -> SUCCEEDED con output {a:1}
  const r4 = await fetch(`${BASE}/workflows/${WF_ID}/execute`, { method: "POST" });
  const b4 = await r4.json();
  console.log("POST /workflows/:id/execute ->", JSON.stringify(b4));
  ok("execute workflow -> 200", r4.status === 200, `(status ${r4.status})`);
  ok("workflow execute status SUCCEEDED", b4.status === "SUCCEEDED", `(got ${b4.status})`);
  ok("workflow execute output {a:1}", b4.output && b4.output.a === 1, JSON.stringify(b4.output));

  // 5) Re-POST mismo id (update) -> version v2 + 2do commit
  const r5 = await fetch(`${BASE}/workflows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: WF_ID, name: "Parse JSON", description: "v2 desc (updated)", steps: [jsonStep] }),
  });
  const b5 = await r5.json();
  console.log("POST /workflows (update) ->", JSON.stringify(b5));
  ok("re-save version v2", b5.version === "v2", `(version ${b5.version})`);

  // GET /workflows?format=okf -> index.md crudo
  const r6 = await fetch(`${BASE}/workflows?format=okf`);
  const okf = await r6.text();
  console.log("--- GET /workflows?format=okf (index.md) ---");
  console.log(okf.split("\n").slice(0, 12).join("\n"));
  ok("GET /workflows?format=okf -> 200", r6.status === 200, `(status ${r6.status})`);
  ok("index.md lists Parse JSON", /Parse JSON/.test(okf), "");

  // git log del repo de workflows (>=2 commits: v1 + v2)
  let log = "";
  try {
    log = git(["log", "--oneline"]);
  } catch (e) {
    log = `(git log failed: ${e.message})`;
  }
  console.log("--- git log --oneline (workflows repo) ---");
  console.log(log);
  const commitCount = log ? log.split("\n").length : 0;
  ok("git commits >= 2 (v1 + v2)", commitCount >= 2, `(commits ${commitCount})`);
  ok("git log mentions v1 and v2", /v1\b/.test(log) && /v2\b/.test(log), "");
} finally {
  await app.close();
  try { rmSync(WORKFLOWS_REPO, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(process.env.RUNS_REPO ?? "", { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(failed ? "\n=== SMOKE-WORKFLOWS FAILED ===" : "\n=== SMOKE-WORKFLOWS PASSED ===");
  process.exit(failed ? 1 : 0);
}