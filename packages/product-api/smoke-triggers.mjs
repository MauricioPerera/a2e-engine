// e2e smoke for the reactive trigger endpoints:
//   - boots the product-api in-process (which boots the mock backend on :3997),
//     with AP_CUSTOM_PIECES_PATHS pointing at the tick trigger + community json
//     piece (+ echo/json roots so the pre-existing endpoints still work),
//   - GET /catalog           (pre-existing endpoint still answers),
//   - POST /triggers         (start a continuous tick loop),
//   - waits a few intervals,
//   - GET /triggers/:id      (firedCount > 0, fired entries SUCCEEDED),
//   - DELETE /triggers/:id   (stopped),
//   - GET /triggers/:id      (404 after stop),
//   - tears everything down (mock + server), freeing the port.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start, PRODUCT_PORT } from "./src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EA = path.resolve(__dirname, "../engine-adapter");
// Order: tick trigger, community json (body), custom-pieces json, echo.
process.env.AP_CUSTOM_PIECES_PATHS = [
  path.join(EA, "custom-pieces-tick/dist"),
  path.join(EA, "community-pieces"),
  path.join(EA, "custom-pieces"),
  path.join(EA, "custom-pieces-echo/dist"),
].join(":");

const BASE = `http://localhost:${PRODUCT_PORT}`;
let failed = false;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await start();
try {
  // 0) pre-existing endpoint still works
  const cat = await fetch(`${BASE}/catalog`);
  const catText = await cat.text();
  ok("GET /catalog -> 200", cat.status === 200, `(status ${cat.status})`);
  ok("catalog lists pieces", /piece-json|piece-echo-auth|JSON|Echo Auth/.test(catText));

  // 1) POST /triggers — start a continuous tick loop, 300ms interval
  const r1 = await fetch(`${BASE}/triggers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      triggerSpec: {
        pieceName: "@automators/piece-tick",
        pieceVersion: "0.1.0",
        triggerName: "new_tick",
        input: {},
      },
      flowSteps: [
        {
          name: "json1",
          pieceName: "@activepieces/piece-json",
          pieceVersion: "0.1.8",
          actionName: "convert_text_to_json",
          input: { text: {ok:true} },
        },
      ],
      intervalMs: 300,
      idField: "id",
    }),
  });
  const b1 = await r1.json();
  console.log("POST /triggers ->", JSON.stringify(b1));
  ok("POST /triggers -> 201", r1.status === 201, `(status ${r1.status})`);
  ok("returns triggerId", typeof b1.triggerId === "string" && b1.triggerId.length > 0);
  const triggerId = b1.triggerId;

  // 2) wait a few intervals so the loop ticks (tick1 fires the 2 fixed items)
  await sleep(1500);

  // 3) GET /triggers/:id
  const r2 = await fetch(`${BASE}/triggers/${triggerId}`);
  const b2 = await r2.json();
  console.log("GET /triggers/:id ->", JSON.stringify(b2));
  ok("GET /triggers/:id -> 200", r2.status === 200, `(status ${r2.status})`);
  ok("running true", b2.running === true, `(got ${b2.running})`);
  ok("ticks > 0", typeof b2.ticks === "number" && b2.ticks > 0, `(got ${b2.ticks})`);
  ok("firedCount > 0", typeof b2.firedCount === "number" && b2.firedCount > 0, `(got ${b2.firedCount})`);
  ok("fired is a non-empty array", Array.isArray(b2.fired) && b2.fired.length > 0, `(len ${b2.fired?.length})`);
  // flowStatus is the engine verdict object ({status:"SUCCEEDED"}); the per-step
  // status lives under flowSteps.<stepName>.status. Accept either form.
  const succStatus = (f) => {
    const fs = f?.flowStatus;
    const top = typeof fs === "string" ? fs : fs?.status;
    if (top === "SUCCEEDED") return true;
    const steps = f?.flowSteps ?? {};
    return Object.values(steps).some((st) => st?.status === "SUCCEEDED");
  };
  const allSucceeded = Array.isArray(b2.fired) && b2.fired.length > 0 && b2.fired.every(succStatus);
  ok("every fired entry status SUCCEEDED", allSucceeded, `(statuses=${JSON.stringify(b2.fired?.map((f) => f?.flowStatus?.status ?? f?.flowStatus))})`);
  if (Array.isArray(b2.fired) && b2.fired.length) {
    console.log("first fired entry:", JSON.stringify(b2.fired[0]));
  }

  // 4) DELETE /triggers/:id
  const r3 = await fetch(`${BASE}/triggers/${triggerId}`, { method: "DELETE" });
  const b3 = await r3.json();
  console.log("DELETE /triggers/:id ->", JSON.stringify(b3));
  ok("DELETE /triggers/:id -> 200", r3.status === 200, `(status ${r3.status})`);
  ok("stopped true", b3.stopped === true, `(got ${b3.stopped})`);

  // 5) GET after delete -> 404
  const r4 = await fetch(`${BASE}/triggers/${triggerId}`);
  ok("GET /triggers/:id after delete -> 404", r4.status === 404, `(status ${r4.status})`);
} finally {
  await app.close();
  console.log(failed ? "\n=== SMOKE FAILED ===" : "\n=== SMOKE PASSED ===");
  process.exit(failed ? 1 : 0);
}
