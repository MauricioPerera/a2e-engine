// Thin HTTP client for the product-api. No framework, just fetch.
// A2E: the MCP tools call the product-api; this is the only place that knows
// where it lives and how to authenticate.

const DEFAULT_BASE = "http://localhost:8080";

export function apiBase(): string {
  const b = process.env.A2E_API_BASE ?? DEFAULT_BASE;
  return b.replace(/\/+$/, ""); // strip trailing slash
}

export function apiKey(): string | undefined {
  return process.env.A2E_API_KEY;
}

export interface ApiCallOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  path: string; // must start with "/"
  body?: unknown;
  // query params; values are url-encoded. undefined/null/empty-string are skipped.
  query?: Record<string, string | number | undefined | null>;
}

function buildUrl(path: string, query?: ApiCallOptions["query"]): string {
  let url = path;
  if (query) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    if (parts.length) url += `?${parts.join("&")}`;
  }
  return url;
}

// apiCall -> returns parsed JSON (or a string for markdown bodies). Throws on
// non-2xx with the body text so the tool handler can surface the real error to
// the LLM.
export async function apiCall(opts: ApiCallOptions): Promise<unknown> {
  const method = opts.method ?? "GET";
  const url = apiBase() + buildUrl(opts.path, opts.query);
  const headers: Record<string, string> = { accept: "application/json" };
  const key = apiKey();
  if (key) headers["X-API-Key"] = key;
  let body: string | undefined;
  if (opts.body !== undefined && method !== "GET" && method !== "DELETE") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`product-api ${method} ${opts.path} -> ${res.status}: ${text}`);
  }
  // Some endpoints return markdown (text/markdown) — surface as a string.
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return text === "" ? null : JSON.parse(text);
  }
  return text;
}