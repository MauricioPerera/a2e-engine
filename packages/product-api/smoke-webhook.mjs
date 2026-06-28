// smoke-webhook.mjs — end-to-end WEBHOOK ingress smoke for the product-api.
//
// Boots the product-api (tsx src/index.ts) as a child process, registers a
// WEBHOOK trigger (@automators/piece-hook / on_event) whose body step is
// @activepieces/piece-json.convert_text_to_json with input { text: "{{item}}" },
// then POSTs {"hello":"world"} to /webhooks/:triggerId and asserts:
//   - fired === 1
//   - results[0].status === "SUCCEEDED"
//   - results[0].output reflects the payload (output.hello === "world")
// Also hits GET /catalog as a no-regression health check. Tears everything down.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = String(process.env.PORT ?? "8098");
const BASE = `http://localhost:${PORT}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function http(method, pathname, body) {
  const headers = { "content-type": "application/json" };
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep text */
    }
  }
  return { status: res.status, body: parsed };
}

async function waitForServer(proc, ms = 15000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const onLog = (d) => {
      const s = String(d);
      process.stdout.write(s);
      if (s.includes("product-api listening")) resolve();
    };
    proc.stdout.on("data", onLog);
    proc.stderr.on("data", (d) => process.stderr.write(String(d)));
    proc.on("exit", (code) => {
      reject(new Error(`server exited early with code ${code}`));
    });
    const iv = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(iv);
        reject(new Error("server did not start in time"));
      }
    }, 200);
  });
}

async function main() {
  const proc = spawn(
    "npx",
    ["tsx", "src/index.ts"],
    {
      cwd: __dirname,
      env: { ...process.env, PORT, MOCK_PORT: process.env.MOCK_PORT ?? "3998" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group so we can kill npx + the tsx child together
    },
  );

  let exitCode = 0;
  try {
    await waitForServer(proc);
    await sleep(500); // let the mock backend settle

    // 1) no-regression health check
    const cat = await http("GET", "/catalog");
    console.log(`\n[smoke] GET /catalog -> HTTP ${cat.status}`);
    if (cat.status !== 200) throw new Error("/catalog did not return 200");

    // 2) register the WEBHOOK trigger
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
          // "{{item}}" -> JSON.stringify(item) at ingress; the body parsed back
          // to an object equals the webhook payload -> proof the payload seeded the flow.
          input: { text: "{{item}}" },
        },
      ],
    });
    console.log("[smoke] POST /webhook-triggers ->", JSON.stringify(reg.body));
    if (reg.status !== 201) throw new Error(`register failed: HTTP ${reg.status}`);
    const { triggerId, webhookUrl } = reg.body;
    if (!triggerId || webhookUrl !== `/webhooks/${triggerId}`) {
      throw new Error(`bad registration response: ${JSON.stringify(reg.body)}`);
    }

    // 3) fire the webhook with a test payload
    const payload = { hello: "world", n: 42 };
    const fire = await http("POST", `/webhooks/${triggerId}`, payload);
    console.log("[smoke] POST /webhooks/:id ->", JSON.stringify(fire.body));
    if (fire.status !== 200) throw new Error(`ingress HTTP ${fire.status}: ${JSON.stringify(fire.body)}`);

    const fired = fire.body.fired;
    const results = fire.body.results;
    if (fired !== 1) throw new Error(`expected fired=1, got ${fired}`);
    if (!Array.isArray(results) || results.length !== 1) {
      throw new Error(`expected 1 result, got ${JSON.stringify(results)}`);
    }
    const r0 = results[0];
    if (r0.status !== "SUCCEEDED") {
      throw new Error(`expected status SUCCEEDED, got ${r0.status} (err=${r0.errorMessage})`);
    }
    const out = r0.output;
    if (!out || out.hello !== "world" || out.n !== 42) {
      throw new Error(`output does not reflect payload: ${JSON.stringify(out)}`);
    }

    console.log("\n[smoke] PASS: fired=1, status=SUCCEEDED, output reflects payload");
    console.log("[smoke] output =", JSON.stringify(out));

    // 4) cleanup
    const del = await http("DELETE", `/webhook-triggers/${triggerId}`);
    console.log("[smoke] DELETE /webhook-triggers/:id ->", JSON.stringify(del.body));
  } catch (e) {
    exitCode = 1;
    console.error("\n[smoke] FAIL:", e?.stack ?? e);
  } finally {
    // Kill the whole process group (npx + the tsx child it spawned), not just
    // the npx parent — otherwise the child stays orphaned listening on PORT.
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    }
    setTimeout(() => {
      try { process.kill(-proc.pid, "SIGKILL"); } catch { /* already gone */ }
      process.exit(exitCode);
    }, 500);
  }
}

main();