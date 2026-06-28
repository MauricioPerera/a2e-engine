// ollama-provider: llama a un LLM via Ollama (api/chat, stream:false).
// Sin API keys. host/model por opts > env > defaults. Timeout y errores claros.
//
// El orquestador invoca al LLM como (prompt, system) => Promise<string>; este
// modulo expone callOllama(prompt, { model?, host?, system? }) y el adaptador
// (prompt, system) => callOllama(prompt, { system }) se construye en el caller.

export type OllamaOptions = {
  model?: string;
  host?: string;
  system?: string;
};

// POST {host}/api/chat { model, messages:[system,user], stream:false }
// Devuelve message.content. Timeout via AbortController (default 120s).
export async function callOllama(prompt: string, opts: OllamaOptions = {}): Promise<string> {
  const host = opts.host ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const model = opts.model ?? process.env.OLLAMA_MODEL ?? "gemma4:31b-cloud";
  const url = `${host.replace(/\/+$/, "")}/api/chat`;
  const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS ?? "120000");
  const body = {
    model,
    messages: [
      { role: "system", content: opts.system ?? "" },
      { role: "user", content: prompt },
    ],
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`ollama HTTP ${res.status}: ${txt.slice(0, 300)}`);
    }
    const data = (await res.json()) as { message?: { content?: string }; error?: string };
    if (typeof data.error === "string" && data.error.length > 0) {
      throw new Error(`ollama error: ${data.error}`);
    }
    const content = data.message?.content;
    if (typeof content !== "string") {
      throw new Error("ollama: respuesta sin message.content");
    }
    return content;
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      throw new Error(`ollama: timeout tras ${timeoutMs}ms`);
    }
    // Re-lanzar mensajes ya prefijados con 'ollama'; envolver el resto como red.
    if (err.message.startsWith("ollama")) throw err;
    throw new Error(`ollama network error: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}