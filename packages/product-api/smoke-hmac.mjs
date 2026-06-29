// smoke-hmac.mjs — HMAC-per-webhook ingress smoke for the product-api.
//
// Phase A (server WITHOUT WEBHOOK_HMAC_OPTIONAL):
//   1) POST /webhook-triggers -> { triggerId, webhookUrl, signingSecret }.
//   2) POST /webhooks/:id with a VALID X-A2E-Signature -> 200, fired>0.
//   3) POST /webhooks/:id with an INVALID signature (wrong secret) -> 401 invalid_signature, no fire.
//   4) POST /webhooks/:id with NO signature header -> 401.
// Phase B (server WITH WEBHOOK_HMAC_OPTIONAL=1): retrocompat — a webhook whose
//   registration carries a secret still accepts an UNSIGNED ingress (legacy
//   behavior), -> 200 fired>0.
//
// Each phase boots its own product-api child process and tears it down.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHmac } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function computeSignature(secret, rawBody) {
  const h = createHmac("sha256", secret);
  h.update(rawBody);
  return `sha256=${h.digest("hex")}`;
}

async function http(base, method, pathname, body, extraHeaders) {
  const headers = { "content-type": "application/json", ...(extraHeaders || {}) };
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let parsed = text;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) { try { parsed = JSON.parse(text); } catch { /* keep */ } }
  return { status: res.status, body: parsed };
}

async function waitForServer(proc, ms = 20000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const onLog = (d) => {
      const s = String(d);
      process.stdout.write(s);
      if (s.includes("product-api listening")) resolve();
    };
    proc.stdout.on("data", onLog);
    proc.stderr.on("data", (d) => process.stderr.write(String(d)));
    proc.on("exit", (code) => reject(new Error(`server exited early with code ${code}`)));
    const iv = setInterval(() => {
      if (Date.now() > deadline) { clearInterval(iv); reject(new Error("server did not start in time")); }
    }, 200);
  });
}

function boot(envExtra) {
  const port = envExtra.PORT;
  const proc = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: __dirname,
    env: { ...process.env, ...envExtra },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  return proc;
}

function killAll(proc) {
  try { process.kill(-proc.pid, "SIGTERM"); } catch { try { proc.kill("SIGTERM"); } catch { /* */ } }
}

const REG_BODY = {
  triggerSpec: { pieceName: "@automators/piece-hook", pieceVersion: "0.1.0", triggerName: "on_event", input: {} },
  flowSteps: [
    {
      name: "json1",
      pieceName: "@activepieces/piece-json",
      pieceVersion: "0.1.8",
      actionName: "convert_text_to_json",
      input: { text: "{{item}}" },
    },
  ],
};

async function phaseA() {
  const PORT = "8099";
  const MOCK = "3999";
  const BASE = `http://localhost:${PORT}`;
  console.log("\n=== Phase A: HMAC enforced (no optional flag) ===");
  const proc = boot({ PORT, MOCK_PORT: MOCK });
  let exit = 0;
  try {
    await waitForServer(proc);
    await sleep(500);

    const reg = await http(BASE, "POST", "/webhook-triggers", REG_BODY);
    console.log("[A] POST /webhook-triggers ->", JSON.stringify(reg.body));
    if (reg.status !== 201) throw new Error(`register failed: HTTP ${reg.status}`);
    const { triggerId, signingSecret } = reg.body;
    if (!triggerId) throw new Error("no triggerId");
    if (!signingSecret) throw new Error("registration did NOT return a signingSecret");

    const payload = { hello: "world", n: 7 };
    const raw = JSON.stringify(payload);

    // (2) VALID signature -> 200, fired>0
    const valid = await http(BASE, "POST", `/webhooks/${triggerId}`, raw, {
      "x-a2e-signature": computeSignature(signingSecret, raw),
    });
    console.log("[A] valid sig   -> HTTP", valid.status, JSON.stringify(valid.body));
    if (valid.status !== 200) throw new Error(`valid sig expected 200, got ${valid.status}`);
    if (!valid.body || !(valid.body.fired > 0)) throw new Error(`valid sig expected fired>0, got ${JSON.stringify(valid.body)}`);

    // (3) INVALID signature (wrong secret) -> 401 invalid_signature
    const invalid = await http(BASE, "POST", `/webhooks/${triggerId}`, raw, {
      "x-a2e-signature": computeSignature("wrong-secret", raw),
    });
    console.log("[A] invalid sig -> HTTP", invalid.status, JSON.stringify(invalid.body));
    if (invalid.status !== 401) throw new Error(`invalid sig expected 401, got ${invalid.status}`);
    if (!invalid.body || invalid.body.error !== "invalid_signature") {
      throw new Error(`expected error invalid_signature, got ${JSON.stringify(invalid.body)}`);
    }

    // (4) NO header -> 401
    const absent = await http(BASE, "POST", `/webhooks/${triggerId}`, raw);
    console.log("[A] no header  -> HTTP", absent.status, JSON.stringify(absent.body));
    if (absent.status !== 401) throw new Error(`no header expected 401, got ${absent.status}`);
    if (!absent.body || absent.body.error !== "invalid_signature") {
      throw new Error(`expected error invalid_signature, got ${JSON.stringify(absent.body)}`);
    }

    console.log("[A] PASS: valid=200+fired, invalid=401, absent=401");
  } catch (e) {
    exit = 1;
    console.error("[A] FAIL:", e?.stack ?? e);
  } finally {
    killAll(proc);
    await sleep(600);
  }
  return exit;
}

async function phaseB() {
  const PORT = "8100";
  const MOCK = "4000";
  const BASE = `http://localhost:${PORT}`;
  console.log("\n=== Phase B: retrocompat (WEBHOOK_HMAC_OPTIONAL=1, unsigned accepted) ===");
  const proc = boot({ PORT, MOCK_PORT: MOCK, WEBHOOK_HMAC_OPTIONAL: "1" });
  let exit = 0;
  try {
    await waitForServer(proc);
    await sleep(500);

    const reg = await http(BASE, "POST", "/webhook-triggers", REG_BODY);
    console.log("[B] POST /webhook-triggers ->", JSON.stringify(reg.body));
    if (reg.status !== 201) throw new Error(`register failed: HTTP ${reg.status}`);
    const { triggerId, signingSecret } = reg.body;
    if (!signingSecret) throw new Error("registration did NOT return a signingSecret (entry has a secret)");

    // UNSIGNED ingress on a webhook that HAS a secret -> allowed (200, fired>0)
    const payload = { hello: "retro", n: 1 };
    const raw = JSON.stringify(payload);
    const fire = await http(BASE, "POST", `/webhooks/${triggerId}`, raw); // NO signature header
    console.log("[B] unsigned   -> HTTP", fire.status, JSON.stringify(fire.body));
    if (fire.status !== 200) throw new Error(`retrocompat expected 200, got ${fire.status}`);
    if (!fire.body || !(fire.body.fired > 0)) throw new Error(`retrocompat expected fired>0, got ${JSON.stringify(fire.body)}`);

    console.log("[B] PASS: optional mode accepts unsigned ingress on a secret-bearing webhook");
  } catch (e) {
    exit = 1;
    console.error("[B] FAIL:", e?.stack ?? e);
  } finally {
    killAll(proc);
    await sleep(600);
  }
  return exit;
}

async function main() {
  const a = await phaseA();
  const b = await phaseB();
  const code = a || b ? 1 : 0;
  console.log("\n[smoke-hmac] RESULT phaseA=" + (a ? "FAIL" : "PASS") + " phaseB=" + (b ? "FAIL" : "PASS"));
  // final cleanup of any lingering process groups
  setTimeout(() => process.exit(code), 300);
}

main();