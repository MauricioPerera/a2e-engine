// A2E MCP tools. Each tool is a thin wrapper over the product-api: the tool
// surface IS the protocol. The LLM can compose+execute workflows, discover
// pieces, list credential REFERENCES (never secrets), and query
// knowledge/runs. It CANNOT write code or see secrets.
//
// A tool handler returns the MCP CallToolResult shape:
//   { content: [{ type: "text", text: "<json>" }] }
// On error it returns isError=true with the message as text (so the LLM sees
// the real failure instead of an opaque transport error).

import { apiCall } from "./client.js";

// JSON Schema used as MCP inputSchema. We keep these as plain JSON Schema
// objects (the low-level Server accepts raw schemas).
export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

// MCP CallToolResult (subset we produce). isError is optional; when true the
// client treats the content as a tool error.
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function ok(result: unknown): ToolResult {
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: "text", text }] };
}

function err(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Wrap a handler so any thrown Error becomes an isError result with the
// message. Keeps tool definitions uniform.
function safe(
  fn: (args: Record<string, unknown>) => Promise<unknown>,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return err((e as Error)?.message ?? String(e));
    }
  };
}

const str = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`'${key}' must be a string`);
  return v;
};

const optStr = (args: Record<string, unknown>, key: string): string | undefined => {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Error(`'${key}' must be a string`);
  return v;
};

const optNum = (args: Record<string, unknown>, key: string): number | undefined => {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`'${key}' must be a finite number`);
  return v;
};

const arr = (args: Record<string, unknown>, key: string): unknown[] => {
  const v = args[key];
  if (!Array.isArray(v)) throw new Error(`'${key}' must be an array`);
  return v;
};

export const tools: ToolDefinition[] = [
  {
    name: "retrieve_catalog",
    description:
      "Discover relevant pieces for a natural-language query, bounded by a token budget. " +
      "Returns a subset of the piece catalog (index entries) that fits the budget so the " +
      "context window is not flooded. Use this first to find which pieces/actions can solve " +
      "the task. GET /catalog/retrieve.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language description of what you want to do." },
        budget: {
          type: "number",
          description: "Max tokens for the returned catalog subset. Defaults to 4000 if omitted.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: safe(async (args) => {
      return apiCall({
        method: "GET",
        path: "/catalog/retrieve",
        query: { q: str(args, "query"), budget: optNum(args, "budget") },
      });
    }),
  },
  {
    name: "get_piece",
    description:
      "Get the full detail (index.md) of one piece: its actions and their props. " +
      "Call this after retrieve_catalog to inspect a specific piece before composing " +
      "a workflow step. GET /pieces/:name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Piece name, e.g. '@activepieces/piece-json'." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: safe(async (args) => {
      return apiCall({ method: "GET", path: `/pieces/${encodeURIComponent(str(args, "name"))}` });
    }),
  },
  {
    name: "list_connections",
    description:
      "List credential REFERENCES available to reference in workflow steps as " +
      "{{connections.<externalId>}}. Returns externalId, displayName, pieceName and type " +
      "only — NEVER the secret value. Optionally filter by projectId. GET /connections.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Optional project scope." },
      },
      additionalProperties: false,
    },
    handler: safe(async (args) => {
      return apiCall({
        method: "GET",
        path: "/connections",
        query: { projectId: optStr(args, "projectId") },
      });
    }),
  },
  {
    name: "execute_workflow",
    description:
      "Compose and execute a workflow from piece steps right now (ephemeral, not saved). " +
      "Each step is a piece invocation: { name, pieceName, pieceVersion, actionName, input, connection? }. " +
      "Only pieces are accepted — there is NO code step and the agent cannot run arbitrary code. " +
      "Returns { status, output, error? }. POST /execute.",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "Ordered piece steps to execute.",
          items: { type: "object" },
        },
      },
      required: ["steps"],
      additionalProperties: false,
    },
    handler: safe(async (args) => {
      return apiCall({ method: "POST", path: "/execute", body: { steps: arr(args, "steps") } });
    }),
  },
  {
    name: "save_workflow",
    description:
      "Persist a named workflow composed of piece steps (so it can be re-run later). " +
      "Returns { id, version, path }. POST /workflows.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable workflow name." },
        description: { type: "string", description: "Optional description." },
        steps: {
          type: "array",
          description: "Ordered piece steps (same shape as execute_workflow).",
          items: { type: "object" },
        },
      },
      required: ["name", "steps"],
      additionalProperties: false,
    },
    handler: safe(async (args) => {
      const body: Record<string, unknown> = { name: str(args, "name"), steps: arr(args, "steps") };
      const d = optStr(args, "description");
      if (d !== undefined) body.description = d;
      return apiCall({ method: "POST", path: "/workflows", body });
    }),
  },
  {
    name: "list_workflows",
    description:
      "List saved workflows (id, name, piecesUsed, stepCount, updatedAt, version). " +
      "Use run_saved_workflow to execute one by id. GET /workflows.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: safe(async () => {
      return apiCall({ method: "GET", path: "/workflows" });
    }),
  },
  {
    name: "run_saved_workflow",
    description:
      "Execute a previously saved workflow by its id. Reuses the stored steps; the agent " +
      "does not need to re-send them. Returns { status, output, error? }. " +
      "POST /workflows/:id/execute.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Workflow id from list_workflows." } },
      required: ["id"],
      additionalProperties: false,
    },
    handler: safe(async (args) => {
      return apiCall({
        method: "POST",
        path: `/workflows/${encodeURIComponent(str(args, "id"))}/execute`,
      });
    }),
  },
  {
    name: "query_knowledge",
    description:
      "Query operational learnings (entries with a freshness verdict per entry, so the " +
      "agent can tell what is still current). Use this before guessing. GET /knowledge.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: safe(async () => {
      return apiCall({ method: "GET", path: "/knowledge" });
    }),
  },
  {
    name: "query_runs",
    description:
      "Query the run history (past executions). Useful to see what ran, what succeeded " +
      "and what failed. GET /runs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: safe(async () => {
      return apiCall({ method: "GET", path: "/runs" });
    }),
  },
  {
    name: "retrieve_pieces",
    description:
      "Level-1 hierarchical retrieval: the relevant pieces for a natural-language query, " +
      "each with its action-NAME hints (no props), bounded by a token budget. Use this FIRST " +
      "to find candidate pieces, then retrieve_actions to drill into one. GET /catalog/pieces.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language description of what you want to do." },
        budget: {
          type: "number",
          description: "Max tokens for the level-1 context. Defaults to 3000 if omitted.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: safe(async (args) => {
      return apiCall({
        method: "GET",
        path: "/catalog/pieces",
        query: { q: str(args, "query"), budget: optNum(args, "budget") },
      });
    }),
  },
  {
    name: "retrieve_actions",
    description:
      "Level-2 hierarchical retrieval: the actions of ONE piece (WITH input props), filtered " +
      "by an optional query and bounded by a token budget. Call this after retrieve_pieces to " +
      "drill into a specific piece before composing a workflow step. GET /catalog/pieces/:name/actions.",
    inputSchema: {
      type: "object",
      properties: {
        piece: { type: "string", description: "Piece name, e.g. '@activepieces/piece-slack'." },
        query: { type: "string", description: "Optional filter to select matching actions of the piece." },
        budget: {
          type: "number",
          description: "Max tokens for the level-2 context. Defaults to 2000 if omitted.",
        },
      },
      required: ["piece"],
      additionalProperties: false,
    },
    handler: safe(async (args) => {
      return apiCall({
        method: "GET",
        path: `/catalog/pieces/${encodeURIComponent(str(args, "piece"))}/actions`,
        query: { q: optStr(args, "query"), budget: optNum(args, "budget") },
      });
    }),
  },
];

// Map name -> handler, for the CallToolRequest handler and for direct
// invocation in the smoke test (part 1 drives the handlers without transport).
export const handlerByName: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> =
  Object.fromEntries(tools.map((t) => [t.name, t.handler]));

// Build the MCP ListToolsResult tools array (name + description + inputSchema).
export function listToolDescriptors(): Array<{ name: string; description: string; inputSchema: JsonSchema }> {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}