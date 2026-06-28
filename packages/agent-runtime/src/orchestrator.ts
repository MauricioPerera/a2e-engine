// orchestrator: loop del AGENT RUNTIME (patron A2E).
// Envuelve un LLM y opera el sustrato product-api:
//   contexto -> LLM compone ExecuteRequest -> validar+ejecutar -> decidir -> reintentar.
// Reusa la logica pura de agent-runtime (parseAgentOutput, decideNext, buildRetryPrompt).
// Sin API keys; el LLM se inyecta (ollama-provider real o stub-provider para tests).

import { parseAgentOutput, decideNext, buildRetryPrompt } from "./agent-runtime.js";

export type AgentRunOptions = {
  apiBase: string;
  projectId?: string;
  llm: (prompt: string, system?: string) => Promise<string>;
  maxRetries?: number;
};

export type AgentRunResult = {
  ok: boolean;
  result?: unknown;
  request?: unknown;
  attempts: number;
  transcript: string[];
};

// Resume un string a `n` chars para el transcript (no volcar prompts completos).
function summarize(s: string, n = 200): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

// POST JSON helper. Devuelve { status, body } (body ya parseado si es JSON).
async function postJson(
  url: string,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: unknown = text;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
  }
  return { status: res.status, body };
}

export async function runAgent(task: string, opts: AgentRunOptions): Promise<AgentRunResult> {
  const maxRetries = opts.maxRetries ?? 3;
  const transcript: string[] = [];

  // 1) Contexto: POST /agent/context { query } -> ctx.context es el SYSTEM del LLM.
  let system = "";
  try {
    const ctxPayload: Record<string, unknown> = { query: task };
    if (opts.projectId) ctxPayload.projectId = opts.projectId;
    const ctx = await postJson(`${opts.apiBase}/agent/context`, ctxPayload);
    const ctxBody = ctx.body as { context?: string; error?: string } | undefined;
    if (ctx.status !== 200) {
      transcript.push(`context error: ${ctxBody?.error ?? ctx.status}`);
    } else {
      system = typeof ctxBody?.context === "string" ? ctxBody.context : "";
      transcript.push(`context ok (${system.length} chars)`);
    }
  } catch (e) {
    transcript.push(`context fetch failed: ${(e as Error).message}`);
  }

  let feedback = "";
  let lastRequest: unknown = undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const prompt = attempt === 1 ? task : buildRetryPrompt(task, feedback);

    // 2) LLM compone el ExecuteRequest (raw).
    let raw: string;
    try {
      raw = await opts.llm(prompt, system);
    } catch (e) {
      feedback = `LLM call failed: ${(e as Error).message}`;
      transcript.push(`attempt ${attempt} llm error: ${feedback}`);
      continue;
    }
    transcript.push(
      `attempt ${attempt} prompt=${JSON.stringify(summarize(prompt))} raw=${JSON.stringify(summarize(raw))}`,
    );

    // 3) Parsear la salida cruda.
    const parsed = parseAgentOutput(raw);
    if (!parsed.ok) {
      feedback = `output no es JSON valido: ${parsed.error}`;
      transcript.push(`attempt ${attempt} parse failed: ${parsed.error}`);
      continue;
    }
    lastRequest = parsed.request;

    // 4) Ejecutar: POST /execute { steps }.
    let exec;
    try {
      exec = await postJson(`${opts.apiBase}/execute`, { steps: parsed.request.steps });
    } catch (e) {
      feedback = `execute fetch failed: ${(e as Error).message}`;
      transcript.push(`attempt ${attempt} exec fetch failed: ${feedback}`);
      continue;
    }
    transcript.push(`attempt ${attempt} exec status=${exec.status}`);

    // 5) Decidir siguiente paso.
    const decision = decideNext(exec.body as Parameters<typeof decideNext>[0]);
    if (decision.done && decision.success) {
      return { ok: true, result: exec.body, request: lastRequest, attempts: attempt, transcript };
    }

    feedback = decision.feedback;
    // Si decideNext no reconoce el body (e.g. 500 con { error: string }), usar ese error.
    if (feedback === "unknown outcome") {
      const errBody = (exec.body as { error?: string } | undefined)?.error;
      if (typeof errBody === "string" && errBody.length > 0) feedback = errBody;
    }

    // 6) (opcional) enriquecer feedback con GET /knowledge, best-effort.
    if (!decision.success) {
      try {
        const kres = await fetch(`${opts.apiBase}/knowledge`, { method: "GET" });
        if (kres.ok) {
          const kbody = (await kres.json()) as { entries?: unknown[] };
          const n = Array.isArray(kbody.entries) ? kbody.entries.length : 0;
          if (n > 0) feedback += ` (knowledge: ${n} entries disponibles)`;
        }
      } catch {
        /* best-effort: ignorar */
      }
    }
  }

  return { ok: false, attempts: maxRetries, request: lastRequest, transcript };
}