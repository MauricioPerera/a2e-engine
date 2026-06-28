// smoke-knowledge.mjs — e2e de la base de conocimiento operacional (OKF + git por
// entry) sobre product-api, incluido el BUCLE DE APRENDIZAJE (run FAILED -> stub).
//
// Arranca el product-api IN-PROCESS con KNOWLEDGE_REPO en un dir temporal (opt-in
// al bucle de aprendizaje) y dispara:
//   - POST /knowledge (un aprendizaje)            -> { id }
//   - GET  /knowledge                              -> lista con freshness 'fresh'
//   - GET  /knowledge/:id                          -> markdown OKF con ## Vigencia
//   - POST /knowledge/:id/attest                   -> ok
//   - GET  /knowledge/:id                          -> muestra attestation (sha256 / by)
//   - POST /execute FALLIDO (piece inexistente)    -> run FAILED -> stub de conocimiento
//   - GET  /knowledge                              -> lista el stub con tag run-failure + sourceRunId
//   - git log del repo de conocimiento
// Limpia el temp dir y mata el server al final.
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

// KNOWLEDGE_REPO y PORT se setean ANTES del import dinámico de index.ts, porque
// handlers.ts los lee al cargar el módulo. KNOWLEDGE_REPO presente = opt-in al
// bucle de aprendizaje (run FAILED -> stub).
const KNOWLEDGE_REPO = mkdtempSync(path.join(os.tmpdir(), "ap-knowledge-"));
process.env.KNOWLEDGE_REPO = KNOWLEDGE_REPO;
// RUNS_REPO aislado también (no-regresión: el run fallido se sigue registrando).
const RUNS_REPO = mkdtempSync(path.join(os.tmpdir(), "ap-runs-k-"));
process.env.RUNS_REPO = RUNS_REPO;
process.env.PORT = "8109";

const { start, PRODUCT_PORT } = await import("./src/index.ts");
const BASE = `http://localhost:${PRODUCT_PORT}`;

let failed = false;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};

function git(args) {
  return execFileSync("git", ["-C", KNOWLEDGE_REPO, ...args], { encoding: "utf8" }).trim();
}

const app = await start();
try {
  // 1) POST /knowledge (un aprendizaje)
  const r1 = await fetch(`${BASE}/knowledge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Cómo reiniciar el servicio X",
      tags: ["ops", "servicio-x"],
      ttlDays: 30,
      problem: "El servicio X no responde tras un deploy.",
      resolution: "Reiniciar el nodo y limpiar la caché.",
    }),
  });
  const b1 = await r1.json();
  console.log("POST /knowledge ->", JSON.stringify(b1));
  ok("POST /knowledge -> 201", r1.status === 201, `(status ${r1.status})`);
  ok("returns id", typeof b1.id === "string" && b1.id.length > 0, `(id ${b1.id})`);
  const kid = b1.id;

  // 2) GET /knowledge -> lista con freshness 'fresh'
  const r2 = await fetch(`${BASE}/knowledge`);
  const b2 = await r2.json();
  console.log("--- GET /knowledge ---");
  console.log(JSON.stringify(b2, null, 2).slice(0, 800));
  ok("GET /knowledge -> 200", r2.status === 200, `(status ${r2.status})`);
  const entry = (b2.entries ?? []).find((e) => e.id === kid);
  ok("list contains created entry", !!entry, "");
  ok("entry freshness verdict 'fresh'", entry?.freshness?.verdict === "fresh", `(got ${entry?.freshness?.verdict})`);

  // 3) GET /knowledge/:id -> markdown OKF con ## Vigencia
  const r3 = await fetch(`${BASE}/knowledge/${kid}`);
  const b3 = await r3.json();
  console.log("--- GET /knowledge/:id (markdown) ---");
  console.log(b3.markdown);
  ok("GET /knowledge/:id -> 200", r3.status === 200, `(status ${r3.status})`);
  ok("markdown has type: knowledge", /type: knowledge/.test(b3.markdown), "");
  ok("markdown has ## Vigencia", /## Vigencia/.test(b3.markdown), "");
  ok("markdown has ## Problem / ## Resolution", /## Problem/.test(b3.markdown) && /## Resolution/.test(b3.markdown), "");
  ok("record freshness fresh", b3.record?.freshness?.verdict === "fresh", `(got ${b3.record?.freshness?.verdict})`);

  // 4) POST /knowledge/:id/attest -> ok
  const r4 = await fetch(`${BASE}/knowledge/${kid}/attest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ by: "mp", expiresAt: "2099-12-31T00:00:00Z" }),
  });
  const b4 = await r4.json();
  console.log("POST /knowledge/:id/attest ->", JSON.stringify(b4));
  ok("POST attest -> 200 ok", r4.status === 200 && b4.ok === true, `(status ${r4.status})`);

  // 5) GET /knowledge/:id -> muestra attestation
  const r5 = await fetch(`${BASE}/knowledge/${kid}`);
  const b5 = await r5.json();
  console.log("--- GET /knowledge/:id (tras attest, frontmatter+vigencia) ---");
  console.log(b5.markdown.split("\n").slice(0, 18).join("\n"));
  ok("attest markdown has attestation by mp", /attested by mp until 2099-12-31/.test(b5.markdown), "");
  ok("attest markdown has sha256 in frontmatter", /^\s+sha256:\s*[0-9a-f]{64}/m.test(b5.markdown), "");
  ok("attest record verdict 'attested'", b5.record?.freshness?.verdict === "attested", `(got ${b5.record?.freshness?.verdict})`);

  // 6) GET /knowledge?format=okf -> index.md crudo
  const r6 = await fetch(`${BASE}/knowledge?format=okf`);
  const t6 = await r6.text();
  console.log("--- GET /knowledge?format=okf (index.md) ---");
  console.log(t6);
  ok("GET /knowledge?format=okf -> 200", r6.status === 200, `(status ${r6.status})`);
  ok("index has type: index", /type: index/.test(t6), "");
  ok("index lists the entry", /Cómo reiniciar el servicio X/.test(t6), "");

  // 7) BUCLE DE APRENDIZAJE: POST /execute FALLIDO -> stub de conocimiento
  const r7 = await fetch(`${BASE}/execute`, {
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
  const b7 = await r7.json();
  console.log("execute(fail) ->", JSON.stringify(b7).slice(0, 160), "...");
  ok("POST /execute fail -> 200 + status FAILED (sin romper /execute)", r7.status === 200 && b7.status === "FAILED", `(status ${r7.status}, body ${b7.status})`);

  // 8) GET /knowledge -> lista el stub con tag run-failure + sourceRunId
  const r8 = await fetch(`${BASE}/knowledge`);
  const b8 = await r8.json();
  console.log("--- GET /knowledge (tras fallo) ---");
  console.log(JSON.stringify(b8, null, 2).slice(0, 1400));
  const stub = (b8.entries ?? []).find((e) => Array.isArray(e.tags) && e.tags.includes("run-failure"));
  ok("stub created with tag run-failure", !!stub, "");
  ok("stub has sourceRunId", typeof stub?.sourceRunId === "string" && stub.sourceRunId.length > 0, `(sourceRunId ${stub?.sourceRunId})`);
  ok("stub title starts 'Run failed:'", typeof stub?.title === "string" && stub.title.startsWith("Run failed:"), `(title ${stub?.title})`);
  ok("stub resolution is empty", stub?.resolution === "", `(got ${JSON.stringify(stub?.resolution)})`);
  ok("stub ttlDays 7 (corto)", stub?.ttlDays === 7, `(got ${stub?.ttlDays})`);
  if (stub) {
    console.log("--- stub markdown (GET /knowledge/:stubId) ---");
    const rs = await fetch(`${BASE}/knowledge/${stub.id}`);
    const bs = await rs.json();
    console.log(bs.markdown);
  }

  // 9) git log del repo de conocimiento
  let log = "";
  try {
    log = git(["log", "--oneline"]);
  } catch (e) {
    log = `(git log failed: ${e.message})`;
  }
  console.log("--- git log --oneline (knowledge repo) ---");
  console.log(log);
  const commits = log ? log.split("\n").filter(Boolean) : [];
  ok("knowledge commits >= 3 (add + attest + stub)", commits.length >= 3, `(commits ${commits.length})`);
} finally {
  await app.close();
  try {
    rmSync(KNOWLEDGE_REPO, { recursive: true, force: true });
    rmSync(RUNS_REPO, { recursive: true, force: true });
  } catch (e) {
    console.error("cleanup failed:", e.message);
  }
  console.log(failed ? "\n=== SMOKE-KNOWLEDGE FAILED ===" : "\n=== SMOKE-KNOWLEDGE PASSED ===");
  process.exit(failed ? 1 : 0);
}