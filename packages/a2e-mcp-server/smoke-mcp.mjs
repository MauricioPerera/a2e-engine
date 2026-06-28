// e2e smoke for the A2E MCP server.
//
// PART 1 (deterministic, direct handlers): boots the product-api in-process
// (:8080), imports the tool handlers from src/tools.ts and calls them against
// the live api:
//   - retrieve_catalog({query:'json'}) -> includes pieces
//   - execute_workflow({steps:[json convert_text_to_json with text '{"a":1}']})
//        -> status SUCCEEDED, output {a:1}
//   - list_connections({}) -> references with NO secret value (asserts
//        'sk-test-ABCD1234' is NOT present anywhere)
//
// PART 2 (MCP transport): wires the server to an in-memory MCP client, calls
// listTools() (asserts ~9 tools) and callTool(retrieve_catalog) over the
// transport.
//
// Kills everything at the end.
import { start as startProductApi } from "../product-api/src/index.ts";
import { handlerByName, tools as toolRegistry } from "./src/tools.ts";
import { createServer } from "./src/server.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const SECRET = "sk-test-ABCD1234";
let failed = false;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};

const printHead = (label, text, n = 400) => {
  const s = typeof text === "string" ? text : JSON.stringify(text);
  console.log(`--- ${label} (first ${n} chars) ---`);
  console.log(s.slice(0, n));
  console.log(`--- end ${label} ---`);
};

// text content of a tool result (part 1 uses direct handlers returning
// { content: [{type:'text', text}] }).
const resultText = (r) => (r.content && r.content[0] ? r.content[0].text : "");
const resultJson = (r) => {
  const t = resultText(r);
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

console.log("=== booting product-api ===");
const app = await startProductApi();
try {
  // give the server a tick to be ready
  await new Promise((r) => setTimeout(r, 100));

  // ---------------- PART 1: direct handlers against the live product-api -----
  console.log("\n=== PART 1: direct handlers ===");

  // 1a) retrieve_catalog
  const r1 = await handlerByName.retrieve_catalog({ query: "json" });
  const j1 = resultJson(r1);
  console.log("retrieve_catalog isError?", r1.isError === true, "  total:", j1?.total, "included:", j1?.included?.length, "estimatedTokens:", j1?.estimatedTokens);
  ok("retrieve_catalog -> not error", r1.isError !== true, r1.isError ? resultText(r1) : "");
  ok("retrieve_catalog includes pieces", j1 && typeof j1.total === "number" && j1.total > 0, `(total=${j1?.total})`);
  printHead("retrieve_catalog result", resultText(r1), 600);

  // 1b) execute_workflow
  const r2 = await handlerByName.execute_workflow({
    steps: [
      {
        name: "parse",
        pieceName: "@activepieces/piece-json",
        pieceVersion: "0.1.8",
        actionName: "convert_text_to_json",
        input: { text: '{"a":1}' },
      },
    ],
  });
  const j2 = resultJson(r2);
  console.log("execute_workflow ->", JSON.stringify(j2));
  ok("execute_workflow -> not error", r2.isError !== true, r2.isError ? resultText(r2) : "");
  ok("execute_workflow status SUCCEEDED", j2?.status === "SUCCEEDED", `(got ${j2?.status})`);
  ok("execute_workflow output {a:1}", j2?.output && j2.output.a === 1, JSON.stringify(j2?.output));

  // 1c) list_connections (SECURITY: no secret)
  const r3 = await handlerByName.list_connections({});
  const t3 = resultText(r3);
  const j3 = resultJson(r3);
  console.log("list_connections ->", JSON.stringify(j3));
  ok("list_connections -> not error", r3.isError !== true, r3.isError ? resultText(r3) : "");
  ok("list_connections returns array", Array.isArray(j3?.connections), `(got ${typeof j3?.connections})`);
  ok("list_connections total >= 1", j3?.total >= 1, `(total ${j3?.total})`);
  ok("list_connections has my-echo-conn ref", Array.isArray(j3?.connections) && j3.connections.some((c) => c.externalId === "my-echo-conn"), "");
  // CRITICAL: secret never in the (stringified) result
  const leakedSecret = t3.includes(SECRET);
  ok("SECURITY: secret NOT in list_connections result", !leakedSecret, leakedSecret ? "LEAKED" : "(no leak)");
  console.log(`SECURITY: secret '${SECRET}' present in list_connections result? ${leakedSecret ? "YES -> LEAK" : "NO (not present)"}`);

  // ---------------- PART 2: MCP transport (in-memory client) ----------------
  console.log("\n=== PART 2: MCP transport (in-memory client) ===");
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "a2e-smoke-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const lt = await client.listTools();
  const names = lt.tools.map((t) => t.name);
  console.log("listTools ->", names.length, "tools:", names.join(", "));
  ok("listTools returns tools", Array.isArray(lt.tools) && lt.tools.length > 0, `(${lt.tools?.length})`);
  ok("listTools returns ~9 tools", lt.tools.length === toolRegistry.length, `(got ${lt.tools.length}, registry ${toolRegistry.length})`);
  for (const expected of ["retrieve_catalog", "get_piece", "list_connections", "execute_workflow", "save_workflow", "list_workflows", "run_saved_workflow", "query_knowledge", "query_runs"]) {
    ok(`listTools has '${expected}'`, names.includes(expected), "");
  }
  // each tool has a JSON-schema inputSchema of type object
  ok("every tool has inputSchema type=object", lt.tools.every((t) => t.inputSchema && t.inputSchema.type === "object"), "");

  // invoke one tool over the transport
  const ct = await client.callTool({ name: "retrieve_catalog", arguments: { query: "json" } });
  const ctText = ct.content && ct.content[0] ? ct.content[0].text : "";
  let ctTotal;
  try { ctTotal = JSON.parse(ctText).total; } catch { ctTotal = undefined; }
  printHead("callTool(retrieve_catalog) over transport", ctText, 400);
  ok("callTool(retrieve_catalog) -> not error", ct.isError !== true, ct.isError ? ctText : "");
  ok("callTool(retrieve_catalog) includes pieces", typeof ctTotal === "number" && ctTotal > 0, `(total=${ctTotal})`);

  await client.close();
} finally {
  await app.close();
  console.log(failed ? "\n=== SMOKE-MCP FAILED ===" : "\n=== SMOKE-MCP PASSED ===");
  process.exit(failed ? 1 : 0);
}