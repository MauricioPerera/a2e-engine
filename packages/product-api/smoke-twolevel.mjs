// smoke-twolevel.mjs — e2e del retriever jerárquico de 2 niveles (product-api).
//
// Arranca product-api (con mock backend) y lanza fetch reales sobre HTTP:
//   NIVEL 1: GET /catalog/pieces?q=send message&budget=4000
//     -> pieces relevantes con sus action-name hints, acotado al budget.
//   NIVEL 2: GET /catalog/pieces/@activepieces/piece-slack/actions?q=message&budget=2000
//     -> actions de UNA piece filtradas por query, CON props, acotado al budget.
//   404: piece ausente en el full-catalog -> 404 claro.
//   MEDICION DE AHORRO: flujo "ir profundo" (nivel1 + drill a 3 pieces via nivel2)
//     vs detail-all de las 710 pieces (mode=detail, budget enorme). Reporta el
//     total del flujo de 2 niveles y el factor de reduccion.
//
// Mata todo al final.
import { start, PRODUCT_PORT } from "./src/index.ts";

const BASE = `http://localhost:${PRODUCT_PORT}`;
let failed = false;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body };
};

const app = await start();
try {
  await new Promise((r) => setTimeout(r, 100));

  // --- no-regresión: endpoints previos siguen vivos -------------------------
  const cat = await fetch(`${BASE}/catalog`);
  ok("no-regression GET /catalog -> 200", cat.status === 200, `(status ${cat.status})`);
  const retr = await get(`/catalog/retrieve?q=slack&budget=4000&mode=index`);
  ok("no-regression GET /catalog/retrieve -> 200", retr.status === 200, `(status ${retr.status})`);

  // --- NIVEL 1 ---------------------------------------------------------------
  // q="send message", budget=4000. Con budget 3000 (default) slack queda omitido
  // (rank 60); con 4000 entra. Lo documentamos: el retriever es el certificado,
  // no se toca.
  console.log("\n--- NIVEL 1: GET /catalog/pieces?q=send message&budget=4000 ---");
  const l1 = await get(`/catalog/pieces?q=${encodeURIComponent("send message")}&budget=4000`);
  console.log("status:", l1.status);
  console.log("estimatedTokens:", l1.body.estimatedTokens, " total:", l1.body.total, " included:", l1.body.included.length, " omitted:", l1.body.omitted);
  console.log("included (first 12):", JSON.stringify(l1.body.included.slice(0, 12)));
  ok("L1 -> 200", l1.status === 200);
  ok("L1 includes slack", Array.isArray(l1.body.included) && l1.body.included.includes("@activepieces/piece-slack"), "");
  ok("L1 includes discord", Array.isArray(l1.body.included) && l1.body.included.includes("@activepieces/piece-discord"), "");
  ok("L1 estimatedTokens <= budget(4000)", typeof l1.body.estimatedTokens === "number" && l1.body.estimatedTokens <= 4000, `(${l1.body.estimatedTokens} <= 4000)`);
  ok("L1 total > 0", l1.body.total > 0, `(total=${l1.body.total})`);
  ok("L1 omitted > 0 (budget activo)", l1.body.omitted > 0, `(omitted=${l1.body.omitted})`);
  ok("L1 context carries action-name hints", typeof l1.body.context === "string" && /actions:/.test(l1.body.context), "");
  ok("L1 context mentions slack hint", typeof l1.body.context === "string" && l1.body.context.includes("@activepieces/piece-slack"), "");

  // Realidad del default (budget 3000): slack queda omitido por ranking.
  const l1default = await get(`/catalog/pieces?q=${encodeURIComponent("send message")}`);
  const slackInDefault = Array.isArray(l1default.body.included) && l1default.body.included.includes("@activepieces/piece-slack");
  console.log(`L1 default budget(3000): tokens=${l1default.body.estimatedTokens} included=${l1default.body.included.length} slack-included?=${slackInDefault} (rank 60 -> omitido por budget)`);

  // --- NIVEL 2 ---------------------------------------------------------------
  console.log("\n--- NIVEL 2: GET /catalog/pieces/@activepieces/piece-slack/actions?q=message&budget=2000 ---");
  const l2 = await get(`/catalog/pieces/${encodeURIComponent("@activepieces/piece-slack")}/actions?q=${encodeURIComponent("message")}&budget=2000`);
  console.log("status:", l2.status);
  console.log("estimatedTokens:", l2.body.estimatedTokens, " total:", l2.body.total, " included:", l2.body.included.length, " omitted:", l2.body.omitted);
  console.log("included:", JSON.stringify(l2.body.included));
  ok("L2 -> 200", l2.status === 200);
  ok("L2 includes send_channel_message", Array.isArray(l2.body.included) && l2.body.included.includes("send_channel_message"), "");
  ok("L2 estimatedTokens <= budget(2000)", typeof l2.body.estimatedTokens === "number" && l2.body.estimatedTokens <= 2000, `(${l2.body.estimatedTokens} <= 2000)`);
  ok("L2 context has props table", typeof l2.body.context === "string" && /\| prop \|/.test(l2.body.context), "");
  ok("L2 context exposes a real prop (channel/text)", typeof l2.body.context === "string" && /\b(channel|text|info)\b/.test(l2.body.context), "");
  console.log("L2 context (first 600 chars):\n" + String(l2.body.context).slice(0, 600));

  // --- 404: piece ausente en el full-catalog ---------------------------------
  console.log("\n--- 404: piece ausente ---");
  const nope = await get(`/catalog/pieces/${encodeURIComponent("@activepieces/piece-nope")}/actions`);
  console.log("status:", nope.status, "error:", nope.body?.error);
  ok("L2 missing piece -> 404", nope.status === 404, `(status ${nope.status})`);

  // --- MEDICION DE AHORRO ----------------------------------------------------
  console.log("\n--- MEDICION DE AHORRO: flujo 2-niveles vs detail-all ---");
  // detail-all: todo el catalogo en mode=detail, budget enorme, query vacia.
  const dall = await get(`/catalog/retrieve?budget=1000000&mode=detail`);
  const detailAllTokens = dall.body.estimatedTokens;
  console.log("detail-all (710 pieces, mode=detail):", detailAllTokens, "tokens,", dall.body.included.length, "pieces included");

  // flujo profundo: nivel1(send message, budget 4000) + drill a 3 pieces via nivel2.
  const drillPieces = ["@activepieces/piece-slack", "@activepieces/piece-discord", "@activepieces/piece-microsoft-teams"];
  let deepTokens = l1.body.estimatedTokens;
  console.log(`flujo profundo: nivel1=${l1.body.estimatedTokens} + drill ${drillPieces.length} pieces (nivel2 q=message budget=2000):`);
  for (const p of drillPieces) {
    const r = await get(`/catalog/pieces/${encodeURIComponent(p)}/actions?q=${encodeURIComponent("message")}&budget=2000`);
    if (r.status !== 200) {
      console.log(`  ${p}: status ${r.status} (no cuenta)`);
      continue;
    }
    console.log(`  ${p}: tokens=${r.body.estimatedTokens} included=${r.body.included.length}`);
    deepTokens += r.body.estimatedTokens;
  }
  const factor = detailAllTokens / deepTokens;
  console.log(`\nFLUJO 2-NIVELES TOTAL: ${deepTokens} tokens`);
  console.log(`DETAIL-ALL:           ${detailAllTokens} tokens`);
  console.log(`FACTOR DE REDUCCION:  ${factor.toFixed(2)}x  (detail-all / flujo 2-niveles)`);
  ok("deep flow tokens < detail-all", deepTokens < detailAllTokens, `(${deepTokens} < ${detailAllTokens})`);
  ok("reduction factor >= 5x", factor >= 5, `(${factor.toFixed(2)}x)`);
} finally {
  await app.close();
  console.log(failed ? "\n=== SMOKE-TWOLEVEL FAILED ===" : "\n=== SMOKE-TWOLEVEL PASSED ===");
  process.exit(failed ? 1 : 0);
}