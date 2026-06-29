// smoke-l3-contract.mjs — L3 e2e: prueba que el ensamblador /agent/context LEYE el
// contrato real contract/context.yaml (no config hardcodeado) y que el yaml es
// AUTORIDAD en runtime: editar el contrato cambia el ensamblado.
//
// Arranca product-api IN-PROCESS una sola vez (como smoke-assemble.mjs). CONTRACT_DIR
// se lee EN CADA llamada dentro de assembleAgentContext, así que entre (a) y (b)
// SOLO cambia a qué yaml apunta process.env.CONTRACT_DIR (mismo servidor corriendo).
//
// (a) CONTRACT_DIR=default (~/product/contract, contrato firmado): POST /agent/context
//     {query:"send a slack message"}; accounting por slot. Los maxTokens efectivos
//     deben coincidir con context.yaml: catalog<=6000, connections<=1000; withinBudget;
//     guardrail ok.
// (b) PRUEBA DE AUTORIDAD: copia contract/ a un dir temporal, EDITA max_tokens del
//     slot catalog de 6000 a 500 en el yaml temporal, apunta process.env.CONTRACT_DIR
//     a ese dir, MISMA petición (mismo servidor) -> el slot catalog ahora acota a
//     <=500 tokens (mucho menos que (a)). Cambiar el contrato cambia el runtime en
//     la siguiente petición -> el yaml manda (no hay config hardcodeado).
//
// In-process: start()/close() una vez, 0 subprocesos sueltos.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { load as yamlLoad, dump as yamlDump } from "js-yaml";

const ROOT = "/home/administrador/product";
const CONTRACT_SRC = path.join(ROOT, "contract");

let failed = false;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};

function readContractSlots(dir) {
  const parsed = yamlLoad(readFileSync(path.join(dir, "context.yaml"), "utf8"));
  return parsed.contract.slots;
}

function printAccounting(label, body, slotsYaml) {
  console.log(`\n=== ACCOUNTING POR SLOT — ${label} ===`);
  const maxBySlot = {};
  for (const s of slotsYaml) maxBySlot[s.id] = s.max_tokens;
  for (const s of body.slots) {
    const cap = maxBySlot[s.id];
    const capStr = cap !== undefined ? ` cap(yaml)=${cap}` : "";
    console.log(
      `  ${s.id.padEnd(14)} tokens=${String(s.tokens).padStart(5)} included=${s.included} truncated=${s.truncated}${capStr}`,
    );
  }
  console.log(
    `  totalTokens=${body.totalTokens} budget=${body.budget} withinBudget=${body.withinBudget} dropped=${JSON.stringify(body.dropped)}`,
  );
  console.log(`  guardrail: ok=${body.guardrail.ok} matched=${body.guardrail.matched}`);
}

async function postContext(port, query) {
  const r = await fetch(`http://localhost:${port}/agent/context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return { status: r.status, body: await r.json() };
}

// Puerto dedicado para este smoke (no chocar con otros smokes en paralelo).
process.env.PORT = process.env.PORT ?? "8090";
const PORT = Number(process.env.PORT);
const mod = await import("./src/index.ts");
const PORT_ACTUAL = mod.PRODUCT_PORT ?? PORT;
const app = await mod.start();

try {
  // ===========================================================================
  // (a) Contrato firmado original: catalog max_tokens=6000, connections=1000.
  // ===========================================================================
  console.log("\n##### (a) contrato firmado (catalog max_tokens=6000) #####");
  delete process.env.CONTRACT_DIR; // default ~/product/contract
  const slotsA = readContractSlots(CONTRACT_SRC);
  const catalogCapA = slotsA.find((s) => s.id === "catalog").max_tokens;
  const connectionsCapA = slotsA.find((s) => s.id === "connections").max_tokens;
  console.log(`yaml (a): catalog.max_tokens=${catalogCapA}, connections.max_tokens=${connectionsCapA}`);
  ok("yaml (a) catalog.max_tokens=6000", catalogCapA === 6000, `(got ${catalogCapA})`);
  ok("yaml (a) connections.max_tokens=1000", connectionsCapA === 1000, `(got ${connectionsCapA})`);

  const rA = await postContext(PORT_ACTUAL, "send a slack message");
  console.log(`[A] HTTP ${rA.status}`);
  ok("(a) POST /agent/context -> 200", rA.status === 200, `(status ${rA.status})`);
  if (rA.status !== 200) {
    console.log("[A] body:", JSON.stringify(rA.body));
    throw new Error("(a) non-200");
  }
  const bodyA = rA.body;
  printAccounting("(a) yaml original", bodyA, slotsA);

  const catalogTokensA = bodyA.slots.find((s) => s.id === "catalog").tokens;
  const connectionsTokensA = bodyA.slots.find((s) => s.id === "connections").tokens;
  ok("(a) catalog tokens <= 6000 (cap yaml)", catalogTokensA <= catalogCapA, `(catalog=${catalogTokensA} cap=${catalogCapA})`);
  ok("(a) connections tokens <= 1000 (cap yaml)", connectionsTokensA <= connectionsCapA, `(connections=${connectionsTokensA} cap=${connectionsCapA})`);
  ok("(a) withinBudget true", bodyA.withinBudget === true, `(totalTokens=${bodyA.totalTokens} budget=${bodyA.budget})`);
  ok("(a) guardrail.ok true (no-secrets del yaml)", bodyA.guardrail.ok === true, `(matched=${bodyA.guardrail.matched})`);

  // ===========================================================================
  // (b) PRUEBA DE AUTORIDAD: copia contract/ a temp, EDITA catalog max_tokens
  // 6000->500, apunta process.env.CONTRACT_DIR al temp, MISMA petición (mismo
  // servidor). El slot catalog debe acotarse a <=500 (mucho menos que (a)).
  // ===========================================================================
  console.log("\n##### (b) PRUEBA DE AUTORIDAD: editar yaml catalog 6000->500 #####");
  const tmpContract = mkdtempSync(path.join(tmpdir(), "a2e-contract-"));
  cpSync(CONTRACT_SRC, tmpContract, { recursive: true });
  const tmpYaml = path.join(tmpContract, "context.yaml");
  const parsedB = yamlLoad(readFileSync(tmpYaml, "utf8"));
  parsedB.contract.slots.find((s) => s.id === "catalog").max_tokens = 500;
  writeFileSync(tmpYaml, yamlDump(parsedB), "utf8");

  const slotsB = readContractSlots(tmpContract);
  const catalogCapB = slotsB.find((s) => s.id === "catalog").max_tokens;
  console.log(`yaml (b) editado: catalog.max_tokens=${catalogCapB}`);
  ok("yaml (b) catalog.max_tokens editado a 500", catalogCapB === 500, `(got ${catalogCapB})`);

  // Apunta el assembler (lectura por llamada) al contrato temporal y re-pide.
  process.env.CONTRACT_DIR = tmpContract;
  const rB = await postContext(PORT_ACTUAL, "send a slack message");
  console.log(`[B] HTTP ${rB.status}`);
  ok("(b) POST /agent/context -> 200", rB.status === 200, `(status ${rB.status})`);
  if (rB.status !== 200) {
    console.log("[B] body:", JSON.stringify(rB.body));
    throw new Error("(b) non-200");
  }
  const bodyB = rB.body;
  printAccounting("(b) yaml editado", bodyB, slotsB);

  const catalogTokensB = bodyB.slots.find((s) => s.id === "catalog").tokens;
  ok("(b) catalog tokens <= 500 (cap yaml editado)", catalogTokensB <= 500, `(catalog=${catalogTokensB} cap=500)`);
  ok("(b) withinBudget true", bodyB.withinBudget === true, `(totalTokens=${bodyB.totalTokens} budget=${bodyB.budget})`);
  ok("(b) guardrail.ok true (no-secrets del yaml)", bodyB.guardrail.ok === true, `(matched=${bodyB.guardrail.matched})`);

  console.log("\n=== COMPARATIVA catalog: budget 6000 vs 500 (autoridad del yaml) ===");
  console.log(`  (a) catalog max_tokens(yaml)=6000  ->  catalog tokens ensamblados = ${catalogTokensA}`);
  console.log(`  (b) catalog max_tokens(yaml)=500   ->  catalog tokens ensamblados = ${catalogTokensB}`);
  ok("AUTORIDAD: editar yaml 6000->500 reduce catalog tokens", catalogTokensB < catalogTokensA, `(a=${catalogTokensA} > b=${catalogTokensB})`);
  ok("AUTORIDAD: (b) catalog acotado a <=500 vs (a) <=6000", catalogTokensB <= 500 && catalogTokensA <= 6000, `(a=${catalogTokensA}, b=${catalogTokensB})`);

  try { rmSync(tmpContract, { recursive: true, force: true }); } catch {}
} finally {
  await app.close();
  console.log("product-api detenido");
}

console.log(failed ? "\n=== SMOKE L3-CONTRACT FAILED ===" : "\n=== SMOKE L3-CONTRACT PASSED ===");
process.exit(failed ? 1 : 0);