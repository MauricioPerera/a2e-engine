// Product HTTP API (node:http, no frameworks). Thin router over the handlers.
import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { ExecuteRequest } from "../../flow-builder/src/flow-builder.js";
import {
  handleCatalog,
  handleCatalogRetrieve,
  handlePiece,
  handleExecute,
  handleCreateTrigger,
  handleGetTrigger,
  handleDeleteTrigger,
  handleCreateWebhookTrigger,
  handleGetWebhookTrigger,
  handleDeleteWebhookTrigger,
  handleWebhookIngress,
  handleListRuns,
  handleGetRun,
  handleCreateWorkflow,
  handleListWorkflows,
  handleGetWorkflow,
  handleExecuteWorkflow,
  handleCreateKnowledge,
  handleListKnowledge,
  handleGetKnowledge,
  handleAttestKnowledge,
  handleListConnections,
  type HandlerResult,
  type CreateTriggerRequest,
  type CreateWebhookTriggerRequest,
  type CreateWorkflowRequest,
  type CreateKnowledgeRequest,
  type AttestKnowledgeRequest,
} from "./handlers.js";

function send(res: ServerResponse, result: HandlerResult): void {
  if (typeof result.body === "string") {
    res.writeHead(result.status, { "content-type": "text/markdown; charset=utf-8" });
    res.end(result.body);
    return;
  }
  res.writeHead(result.status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(result.body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (method === "GET" && pathname === "/catalog") return send(res, handleCatalog());

  // GET /catalog/retrieve?q=<query>&budget=<maxTokens>&mode=index|detail ->
  //   subconjunto del catalogo acotado al budget (provider okf_catalog).
  if (method === "GET" && pathname === "/catalog/retrieve") {
    const q = url.searchParams.get("q") ?? "";
    const budgetRaw = url.searchParams.get("budget");
    const budget = budgetRaw ? Number(budgetRaw) : undefined;
    const mode = url.searchParams.get("mode") ?? undefined;
    return send(res, handleCatalogRetrieve(q, budget, mode));
  }

  // GET /connections?projectId=&piece=&format=json|context&budget= ->
  //   REFERENCIAS de credenciales (nombre/piece/auth) del vault. NUNCA secretos.
  if (method === "GET" && pathname === "/connections") {
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const piece = url.searchParams.get("piece") ?? undefined;
    const format = url.searchParams.get("format") ?? undefined;
    const budgetRaw = url.searchParams.get("budget");
    const budget = budgetRaw ? Number(budgetRaw) : undefined;
    return send(res, handleListConnections({ projectId, piece, format, budget }));
  }

  if (method === "GET" && pathname.startsWith("/pieces/")) {
    const name = decodeURIComponent(pathname.slice("/pieces/".length));
    return send(res, handlePiece(name));
  }

  if (method === "POST" && pathname === "/execute") {
    const raw = await readBody(req);
    let parsed: ExecuteRequest;
    try {
      parsed = JSON.parse(raw) as ExecuteRequest;
    } catch {
      return send(res, { status: 400, body: { error: "body must be valid JSON" } });
    }
    return send(res, await handleExecute(parsed));
  }

  // Reactive triggers: POST /triggers, GET /triggers/:id, DELETE /triggers/:id.
  if (method === "POST" && pathname === "/triggers") {
    const raw = await readBody(req);
    let parsed: CreateTriggerRequest;
    try {
      parsed = JSON.parse(raw) as CreateTriggerRequest;
    } catch {
      return send(res, { status: 400, body: { error: "body must be valid JSON" } });
    }
    return send(res, handleCreateTrigger(parsed));
  }

  if (pathname.startsWith("/triggers/")) {
    const id = decodeURIComponent(pathname.slice("/triggers/".length));
    if (!id) return send(res, { status: 404, body: { error: "trigger id required" } });
    if (method === "GET") return send(res, handleGetTrigger(id));
    if (method === "DELETE") return send(res, handleDeleteTrigger(id));
  }

  // --- WEBHOOK triggers (passive: register, then fire via POST /webhooks/:id) ---
  // /webhook-triggers (exact) MUST be matched before /webhooks/ (prefix) so the
  // two never collide: "/webhook-triggers" does not start with "/webhooks/".
  if (method === "POST" && pathname === "/webhook-triggers") {
    const raw = await readBody(req);
    let parsed: CreateWebhookTriggerRequest;
    try {
      parsed = JSON.parse(raw) as CreateWebhookTriggerRequest;
    } catch {
      return send(res, { status: 400, body: { error: "body must be valid JSON" } });
    }
    return send(res, handleCreateWebhookTrigger(parsed));
  }

  if (pathname === "/webhook-triggers" && (method === "GET" || method === "DELETE")) {
    // No id -> list is not supported in MVP; require /webhook-triggers/:id.
    return send(res, { status: 404, body: { error: "use /webhook-triggers/:id" } });
  }

  if (pathname.startsWith("/webhook-triggers/")) {
    const id = decodeURIComponent(pathname.slice("/webhook-triggers/".length));
    if (!id) return send(res, { status: 404, body: { error: "trigger id required" } });
    if (method === "GET") return send(res, handleGetWebhookTrigger(id));
    if (method === "DELETE") return send(res, handleDeleteWebhookTrigger(id));
  }

  // POST /webhooks/:triggerId -> ingress: run the trigger with the inbound event.
  if (method === "POST" && pathname.startsWith("/webhooks/")) {
    const triggerId = decodeURIComponent(pathname.slice("/webhooks/".length));
    if (!triggerId) return send(res, { status: 404, body: { error: "trigger id required" } });
    const raw = await readBody(req);
    let body: unknown = undefined;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        // Non-JSON body: pass the raw string through as the body.
        body = raw;
      }
    }
    // Flatten query params and headers to Record<string,string> (TriggerPayload shape).
    const queryParams: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) queryParams[k] = v;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(",");
    }
    return send(
      res,
      await handleWebhookIngress(triggerId, {
        body,
        headers,
        queryParams,
        method,
      }),
    );
  }

  // --- run-history (OKF + git por run) -----------------------------------
  // GET /runs            -> { dates, runs } (recientes; o ?date=YYYY-MM-DD)
  // GET /runs/:date/:runId -> markdown del run
  if (method === "GET" && pathname === "/runs") {
    const date = url.searchParams.get("date") ?? undefined;
    return send(res, await handleListRuns(date));
  }

  if (method === "GET" && pathname.startsWith("/runs/")) {
    const rest = decodeURIComponent(pathname.slice("/runs/".length));
    const parts = rest.split("/");
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      return send(res, { status: 400, body: { error: "expected /runs/:date/:runId" } });
    }
    const [date, runId] = parts;
    return send(res, await handleGetRun(date, runId));
  }

  // --- workflow-registry (OKF + git por workflow) -------------------------
  // POST /workflows              -> guarda (genera id, versiona en re-save)
  // GET  /workflows              -> lista (?format=okf -> index.md crudo)
  // GET  /workflows/:id          -> doc OKF (markdown) + record
  // POST /workflows/:id/execute  -> re-ejecuta el workflow guardado
  if (method === "POST" && pathname === "/workflows") {
    const raw = await readBody(req);
    let parsed: CreateWorkflowRequest;
    try {
      parsed = JSON.parse(raw) as CreateWorkflowRequest;
    } catch {
      return send(res, { status: 400, body: { error: "body must be valid JSON" } });
    }
    return send(res, await handleCreateWorkflow(parsed));
  }

  if (method === "GET" && pathname === "/workflows") {
    const format = url.searchParams.get("format") ?? undefined;
    return send(res, await handleListWorkflows(format));
  }

  if (pathname.startsWith("/workflows/")) {
    const rest = decodeURIComponent(pathname.slice("/workflows/".length));
    const parts = rest.split("/");
    if (!parts[0]) return send(res, { status: 404, body: { error: "workflow id required" } });
    const [id, op] = parts;
    if (method === "GET" && parts.length === 1) {
      return send(res, await handleGetWorkflow(id));
    }
    if (method === "POST" && parts.length === 2 && op === "execute") {
      return send(res, await handleExecuteWorkflow(id));
    }
  }

  // --- knowledge-base (OKF + git por entry) ---------------------------------
  // POST   /knowledge             -> guarda aprendizaje (genera id, commit)
  // GET    /knowledge             -> lista con freshness por entry (?format=okf -> index.md)
  // GET    /knowledge/:id         -> doc OKF (markdown) + record
  // POST   /knowledge/:id/attest  -> atesta vigencia humana
  if (method === "POST" && pathname === "/knowledge") {
    const raw = await readBody(req);
    let parsed: CreateKnowledgeRequest;
    try {
      parsed = JSON.parse(raw) as CreateKnowledgeRequest;
    } catch {
      return send(res, { status: 400, body: { error: "body must be valid JSON" } });
    }
    return send(res, await handleCreateKnowledge(parsed));
  }

  if (method === "GET" && pathname === "/knowledge") {
    const format = url.searchParams.get("format") ?? undefined;
    return send(res, await handleListKnowledge(format));
  }

  if (pathname.startsWith("/knowledge/")) {
    const rest = decodeURIComponent(pathname.slice("/knowledge/".length));
    const parts = rest.split("/");
    if (!parts[0]) return send(res, { status: 404, body: { error: "knowledge id required" } });
    const [id, op] = parts;
    if (method === "GET" && parts.length === 1) {
      return send(res, await handleGetKnowledge(id));
    }
    if (method === "POST" && parts.length === 2 && op === "attest") {
      const raw = await readBody(req);
      let parsed: AttestKnowledgeRequest;
      try {
        parsed = JSON.parse(raw) as AttestKnowledgeRequest;
      } catch {
        return send(res, { status: 400, body: { error: "body must be valid JSON" } });
      }
      return send(res, await handleAttestKnowledge(id, parsed));
    }
  }

    send(res, { status: 404, body: { error: `no route for ${method} ${pathname}` } });
}

export function createProductServer(): Server {
  return createHttpServer((req, res) => {
    route(req, res).catch((e) => {
      try {
        send(res, { status: 500, body: { error: `unhandled: ${(e as Error).message}` } });
      } catch {
        /* response already sent */
      }
    });
  });
}
