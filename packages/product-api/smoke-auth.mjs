// smoke-auth.mjs — e2e API-key auth smoke for product-api.
// Boots the server with API_KEYS=testkey:demo-project, then checks:
//   1) GET /catalog with NO header        -> 401
//   2) GET /catalog with X-API-Key: testkey -> 200
//   3) GET /catalog with a bad key        -> 401
//   4) Register a webhook trigger WITH the key, then POST /webhooks/:id
//      WITHOUT any key -> NOT 401 (webhook ingress is the documented exemption).
// Tears the server down at the end.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = String(process.env.PORT ?? "8099");
const MOCK_PORT = String(process.env.MOCK_PORT ?? "3999");
const BASE = `http://localhost:${PORT}`;
const API_KEYS = "testkey:demo-project";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function http(method, pathname, body, headers) {
  const h = { "content-type": "application/json", ...(headers || {}) };
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
  }
  return { status: res.status, body: parsed };
}

async function waitForServer(proc, ms = 15000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => {
      const s = String(d); process.stdout.write(s);
      if (s.includes("product-api listening")) resolve();
    });
    proc.stderr.on("data", (d) => process.stderr.write(String(d)));
    proc.on("exit", (code) => reject(new Error(`server exited early with code ${code}`)));
    const iv = setInterval(() => {
      if (Date.now() > deadline) { clearInterval(iv); reject(new Error("server did not start in time")); }
    }, 200);
  });
}

let failed = false;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};

const proc = spawn("npx", ["tsx", "src/index.ts"], {
  cwd: __dirname,
  env: { ...process.env, PORT, MOCK_PORT, API_KEYS },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});

try {
  await waitForServer(proc);
  await sleep(500);

  // 1) no header -> 401
  const noKey = await http("GET", "/catalog");
  console.log(`\n[smoke] GET /catalog (no header) -> HTTP ${noKey.status} ${JSON.stringify(noKey.body)}`);
  ok("no header -> 401", noKey.status === 401, `(status ${noKey.status})`);
  ok("401 body {error:unauthorized}", noKey.body && noKey.body.error === "unauthorized", JSON.stringify(noKey.body));

  // 2) valid key -> 200
  const good = await http("GET", "/catalog", undefined, { "X-API-Key": "testkey" });
  console.log(`[smoke] GET /catalog (X-API-Key: testkey) -> HTTP ${good.status}`);
  ok("valid key -> 200", good.status === 200, `(status ${good.status})`);

  // 3) bad key -> 401
  const bad = await http("GET", "/catalog", undefined, { "X-API-Key": "wrongkey" });
  console.log(`[smoke] GET /catalog (bad key) -> HTTP ${bad.status} ${JSON.stringify(bad.body)}`);
  ok("bad key -> 401", bad.status === 401, `(status ${bad.status})`);

  // 3b) Bearer alternative also works
  const bearer = await http("GET", "/catalog", undefined, { Authorization: "Bearer testkey" });
  ok("Bearer key -> 200", bearer.status === 200, `(status ${bearer.status})`);

  // 4) webhook ingress exemption: register WITH key, fire WITHOUT key -> not 401
  const reg = await http("POST", "/webhook-triggers", {
    triggerSpec: {
      pieceName: "@automators/piece-hook",
      pieceVersion: "0.1.0",
      triggerName: "on_event",
      input: {},
    },
    flowSteps: [
      {
        name: "json1",
        pieceName: "@activepieces/piece-json",
        pieceVersion: "0.1.8",
        actionName: "convert_text_to_json",
        input: { text: "{{item}}" },
      },
    ],
  }, { "X-API-Key": "testkey" });
  console.log(`[smoke] POST /webhook-triggers (with key) -> HTTP ${reg.status}`);
  ok("register with key -> 201", reg.status === 201, `(status ${reg.status})`);
  if (reg.status !== 201) throw new Error("cannot register webhook trigger; aborting webhook test");
  const triggerId = reg.body.triggerId;

  const fire = await http("POST", `/webhooks/${triggerId}`, { hello: "world", n: 42 });
  console.log(`[smoke] POST /webhooks/:id (NO key) -> HTTP ${fire.status} ${JSON.stringify(fire.body).slice(0,160)}`);
  ok("webhook ingress without key -> NOT 401", fire.status !== 401, `(status ${fire.status})`);
  ok("webhook ingress succeeded (fired=1)", fire.body && fire.body.fired === 1, JSON.stringify(fire.body && fire.body.fired));
} catch (e) {
  console.error("[smoke] ERROR:", e.message);
  failed = true;
} finally {
  try { process.kill(-proc.pid, "SIGTERM"); } catch { proc.kill("SIGTERM"); }
  await sleep(300);
  try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ }
  console.log(failed ? "\n=== SMOKE-AUTH FAILED ===" : "\n=== SMOKE-AUTH PASSED ===");
  process.exit(failed ? 1 : 0);
}
