// context-assembler — Lógica PURA del ensamblador de contexto del agente (L3 CCDD).
// Sin red, sin FS, sin Date. Solo funciones puras que respetan el contrato:
// slots con prioridad + budget de tokens + compaction, y guardrails regex.

export type Compaction = 'none' | 'summarize' | 'truncate';

export interface SlotInput {
  id: string;
  priority: number;
  content: string;
  maxTokens?: number;
  compaction: Compaction;
}

export interface SlotResult {
  id: string;
  tokens: number;
  included: boolean;
  truncated: boolean;
}

export interface Assembly {
  context: string;
  slots: SlotResult[];
  totalTokens: number;
  budget: number;
  withinBudget: boolean;
  dropped: string[];
}

const TOKEN_CHARS = 4;
const TRUNC_SUFFIX = ' …[truncated]';

/**
 * Estima tokens de un texto como ceil(len/4).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_CHARS);
}

/**
 * Recorta `text` a ~maxTokens (maxTokens*4 chars) y añade ` …[truncated]` si recorta.
 */
export function truncateToTokens(
  text: string,
  maxTokens: number,
): { text: string; truncated: boolean } {
  const limit = Math.max(0, maxTokens) * TOKEN_CHARS;
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, limit) + TRUNC_SUFFIX, truncated: true };
}

/**
 * Aplica el budget per-slot según maxTokens + compaction.
 * - 'none': slot crítico, NO se recorta aunque exceda maxTokens.
 * - 'truncate' / 'summarize': se trunca deterministamente a maxTokens (summarize = truncate en MVP).
 */
export function applyPerSlotBudget(
  slot: SlotInput,
): { content: string; tokens: number; truncated: boolean } {
  const baseTokens = estimateTokens(slot.content);
  if (slot.maxTokens === undefined || baseTokens <= slot.maxTokens) {
    return { content: slot.content, tokens: baseTokens, truncated: false };
  }
  if (slot.compaction === 'none') {
    return { content: slot.content, tokens: baseTokens, truncated: false };
  }
  const tr = truncateToTokens(slot.content, slot.maxTokens);
  return { content: tr.text, tokens: estimateTokens(tr.text), truncated: tr.truncated };
}

type InclusionDecision =
  | { kind: 'include'; content: string; truncated: boolean }
  | { kind: 'drop' };

/**
 * Decide si un slot (ya con budget per-slot aplicado) se incluye, trunca o dropea
 * según el `remaining` (presupuesto disponible) y su compaction.
 */
function decideInclusion(
  slot: SlotInput,
  budgeted: { content: string; tokens: number; truncated: boolean },
  remaining: number,
): InclusionDecision {
  if (budgeted.tokens <= remaining) {
    return { kind: 'include', content: budgeted.content, truncated: budgeted.truncated };
  }
  // No cabe entero.
  if (slot.compaction === 'none') {
    // Slot crítico: se incluye entero aunque exceda (marcado por withinBudget a nivel ensamble).
    return { kind: 'include', content: budgeted.content, truncated: budgeted.truncated };
  }
  if (remaining > 0) {
    // compaction permite truncar al espacio que queda.
    const tr = truncateToTokens(budgeted.content, remaining);
    return { kind: 'include', content: tr.text, truncated: true };
  }
  return { kind: 'drop' };
}

function byPriorityAsc(a: SlotInput, b: SlotInput): number {
  return a.priority - b.priority;
}

/**
 * Ensamina slots en orden de prioridad ASC (0 = más alta) dentro del presupuesto
 * totalBudget - reserveOutput. Los críticos ('none') se incluyen enteros aunque excedan
 * (withinBudget=false); los comprimibles se truncan al espacio restante o se dropean.
 */
export function assembleContext(
  slots: SlotInput[],
  opts: { totalBudget: number; reserveOutput?: number },
): Assembly {
  const budget = opts.totalBudget - (opts.reserveOutput ?? 0);
  const sorted = [...slots].sort(byPriorityAsc);
  const results: SlotResult[] = [];
  const dropped: string[] = [];
  const parts: string[] = [];
  let used = 0;

  for (const slot of sorted) {
    const budgeted = applyPerSlotBudget(slot);
    const remaining = budget - used;
    const decision = decideInclusion(slot, budgeted, remaining);
    if (decision.kind === 'drop') {
      dropped.push(slot.id);
      results.push({ id: slot.id, tokens: 0, included: false, truncated: false });
      continue;
    }
    const tokens = estimateTokens(decision.content);
    used += tokens;
    parts.push(`## ${slot.id}\n${decision.content}`);
    results.push({ id: slot.id, tokens, included: true, truncated: decision.truncated });
  }

  return {
    context: parts.join('\n\n'),
    slots: results,
    totalTokens: used,
    budget,
    withinBudget: used <= budget,
    dropped,
  };
}

/**
 * Guardrail regex. matched = el patrón aparece en el texto; ok = !matched.
 * Para no-secrets: ok=false si aparece un secreto (matched=true).
 */
export function applyRegexGuardrail(
  text: string,
  pattern: string,
): { ok: boolean; matched: boolean } {
  const matched = new RegExp(pattern).test(text);
  return { ok: !matched, matched };
}