// agent-runtime: lógica pura del patrón orquestador A2E.
// Parsea la salida cruda del LLM en un ExecuteRequest y decide el siguiente
// paso según el resultado de ejecución. Sin red/FS/Date.

export type ExecuteRequest = { steps: Array<Record<string, unknown>> };

export type ParseResult =
  | { ok: true; request: ExecuteRequest }
  | { ok: false; error: string };

export type ExecOutcome =
  | { status?: string; output?: unknown; error?: string }
  | { error: 'validation_failed'; steps: Array<{ name: string; errors: string[] }> };

export type Decision = { done: boolean; success: boolean; feedback: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Estado mutable del escaneo brace-balanced: profundidad y modo string/escape.
type ScanState = { depth: number; inString: boolean; escape: boolean };

// Avanza el estado un carácter. Dentro de strings ignora llaves y trata escapes.
function scanChar(ch: string, s: ScanState): void {
  if (s.inString) {
    if (s.escape) { s.escape = false; return; }
    if (ch === '\\') { s.escape = true; return; }
    if (ch === '"') s.inString = false;
    return;
  }
  if (ch === '"') { s.inString = true; return; }
  if (ch === '{') { s.depth++; return; }
  if (ch === '}') s.depth--;
}

// Escanea el substring `{...}` balanceado comenzando en `start` (la primera `{`).
// Respeta strings y escapes para no contar llaves dentro de literales de cadena.
// Devuelve el índice del `}` que cierra y el slice, o null si nunca se balancea.
function findBalancedObject(text: string, start: number): { end: number; slice: string } | null {
  const s: ScanState = { depth: 0, inString: false, escape: false };
  for (let i = start; i < text.length; i++) {
    const before = s.depth;
    scanChar(text[i], s);
    // El `}` que lleva depth de 1 -> 0 cierra el objeto exterior.
    if (s.depth === 0 && text[i] === '}' && before === 1) {
      return { end: i, slice: text.slice(start, i + 1) };
    }
  }
  return null;
}

// Devuelve el primer objeto JSON balanceado {...} válido dentro de text.
// Soporta bloques ```json ... ```, JSON crudo y JSON embebido en prosa.
// null si no hay JSON válido.
export function extractJson(text: string): string | null {
  let pos = 0;
  // Recorremos cada `{` candidata; si el slice balanceado no parsea, seguimos.
  while (pos < text.length) {
    const start = text.indexOf('{', pos);
    if (start === -1) return null;
    const found = findBalancedObject(text, start);
    if (found === null) return null;
    try {
      JSON.parse(found.slice);
      return found.slice;
    } catch {
      pos = found.end + 1;
    }
  }
  return null;
}

// Parsea la salida cruda del LLM en un ExecuteRequest.
export function parseAgentOutput(text: string): ParseResult {
  const json = extractJson(text);
  if (json === null) return { ok: false, error: 'no JSON found' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  if (!isPlainObject(parsed)) return { ok: false, error: 'missing steps array' };
  const steps = (parsed as Record<string, unknown>).steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, error: 'missing steps array' };
  }
  for (const step of steps) {
    if (!isPlainObject(step)) return { ok: false, error: 'steps must be objects' };
  }
  const validSteps = steps as Record<string, unknown>[];
  return { ok: true, request: { steps: validSteps } };
}

// Resume los errores de un ExecOutcome en un string de feedback.
export function summarizeErrors(outcome: ExecOutcome): string {
  if (outcome.error === 'validation_failed') {
    return outcome.steps
      .map((s) => `step ${s.name}: ${s.errors.join(', ')}`)
      .join('; ');
  }
  if (outcome.status === 'FAILED') {
    const err = outcome.error;
    if (typeof err === 'string' && err.length > 0) return err;
    const out = outcome.output;
    return typeof out === 'string' ? out : '';
  }
  return '';
}

// Decide el siguiente paso del loop según el resultado de ejecución.
export function decideNext(outcome: ExecOutcome): Decision {
  if (outcome.error === 'validation_failed') {
    return { done: false, success: false, feedback: summarizeErrors(outcome) };
  }
  if (outcome.status === 'SUCCEEDED') {
    return { done: true, success: true, feedback: '' };
  }
  if (outcome.status === 'FAILED') {
    return { done: false, success: false, feedback: summarizeErrors(outcome) };
  }
  return { done: false, success: false, feedback: 'unknown outcome' };
}

// Construye el prompt de reintento para el LLM: tarea + feedback del fallo.
export function buildRetryPrompt(originalTask: string, feedback: string): string {
  return `${originalTask}\n\nTu intento anterior fallo: ${feedback}. Corrige el ExecuteRequest.`;
}