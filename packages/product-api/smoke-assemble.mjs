// smoke-assemble.mjs — L3 e2e: arranca product-api (siembra credencial sk-test-ABCD1234
// via mock-backend), POST /agent/context { query:"send a slack message" } y verifica:
//  - context incluye slots criticos: ## system, ## policies, ## catalog, ## connections (con {{connections.X}}), ## user_message
//  - withinBudget true (reporta accounting por slot)
//  - guardrail.ok true (no-secrets)
//  - CRITICO: el secreto sembrado sk-test-ABCD1234 NO aparece en el context
import { start, PRODUCT_PORT } from "./src/index.ts";

const BASE = `http://localhost:${PRODUCT_PORT}`;
let failed = false;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};

const SECRET = "sk-test-ABCD1234"; // sembrado por mock-backend (my-echo-conn)

const app = await start();
try {
  const r = await fetch(`${BASE}/agent/context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "send a slack message" }),
  });
  const body = await r.json();
  console.log("HTTP", r.status);
  ok("POST /agent/context -> 200", r.status === 200, `(status ${r.status})`);

  if (r.status !== 200) {
    console.log("body:", JSON.stringify(body));
    throw new Error("non-200, abort");
  }

  const { context, slots, totalTokens, budget, withinBudget, dropped, guardrail } = body;

  // --- accounting por slot ---
  console.log("\n=== ACCOUNTING POR SLOT ===");
  for (const s of slots) {
    console.log(
      `  ${s.id.padEnd(14)} tokens=${String(s.tokens).padStart(5)} included=${s.included} truncated=${s.truncated}`,
    );
  }
  console.log(`  totalTokens=${totalTokens} budget=${budget} withinBudget=${withinBudget} dropped=${JSON.stringify(dropped)}`);
  console.log(`  guardrail: ok=${guardrail.ok} matched=${guardrail.matched}`);

  // --- aserciones de slots criticos presentes ---
  ok("context incluye ## system", context.includes("## system"));
  ok("context incluye ## policies", context.includes("## policies"));
  ok("context incluye ## catalog", context.includes("## catalog"));
  ok("context incluye ## connections", context.includes("## connections"));
  ok("connections tiene {{connections.X}}", /\{\{connections\.[^}]+\}\}/.test(context));
  ok("context incluye ## user_message", context.includes("## user_message"));
  ok("catalog acota pieces relevantes (slack)", /slack/i.test(context));

  // --- budget ---
  ok("withinBudget true", withinBudget === true, `(totalTokens=${totalTokens} budget=${budget})`);

  // --- guardrail ---
  ok("guardrail.ok true (no-secrets)", guardrail.ok === true, `(matched=${guardrail.matched})`);

  // --- CRITICO: no-fuga del secreto ---
  const leaked = context.includes(SECRET);
  ok(`NO FUGA: secreto ${SECRET} ausente del context`, !leaked);
  if (leaked) {
    console.log("!!! CONTEXTO FUGA EL SECRETO !!!");
    console.log(context);
  }

  // --- resumen del context ensamblado (slots, sin volcar todo) ---
  console.log("\n=== CONTEXTO ENSAMBLADO (resumen por slot, primeros 3 lines c/u) ===");
  const parts = context.split(/\n\n## /);
  for (const part of parts) {
    const lines = part.split("\n");
    const head = lines[0].replace(/^## /, "");
    console.log(`\n--- ## ${head} ---`);
    console.log(lines.slice(0, 4).join("\n"));
    if (lines.length > 4) console.log(`  ... (${lines.length - 4} more lines)`);
  }
} finally {
  await app.close();
  console.log(failed ? "\n=== SMOKE ASSEMBLE FAILED ===" : "\n=== SMOKE ASSEMBLE PASSED ===");
  process.exit(failed ? 1 : 0);
}
