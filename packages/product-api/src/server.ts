// Product HTTP API (node:http, no frameworks). Thin router over the handlers.
import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { ExecuteRequest } from "../../flow-builder/src/flow-builder.js";
import {
  handleCatalog,
  handlePiece,
  handleExecute,
  handleCreateTrigger,
  handleGetTrigger,
  handleDeleteTrigger,
  handleCreateWebhookTrigger,
  handleGetWebhookTrigger,
  handleDeleteWebhookTrigger,
  handleWebhookIngress,
  type HandlerResult,
  type CreateTriggerRequest,
  type CreateWebhookTriggerRequest,
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
