// contract-config — Transformación PURA del contrato CCDD (context.yaml ya parseado a
// objeto) al config que consume el ensamblador (assembleContext). Sin red, sin FS, sin Date,
// sin lib de yaml: recibe el contrato YA PARSEADO. Hace del contrato firmado la autoridad de
// runtime en vez del config de slots hardcodeado en L3.

import type { SlotInput } from './context-assembler.ts';

export type SlotConfig = {
  id: string;
  priority: number;
  maxTokens?: number;
  compaction: 'none' | 'summarize' | 'truncate';
  sourceType: string;
  path?: string;
  provider?: string;
};

export type GuardrailConfig = {
  id: string;
  type: string;
  pattern?: string;
  onFail?: string;
  schemaPath?: string;
  targetSlot?: string;
};

export type AssemblyConfig = {
  totalBudget: number;
  reserveOutput: number;
  slots: SlotConfig[];
  guardrails: GuardrailConfig[];
};

export type ConfigFinding = {
  level: 'error' | 'warn';
  code: string;
  message: string;
};

const COMPACTIONS: ReadonlyArray<string> = ['none', 'summarize', 'truncate'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0;
}

function err(code: string, message: string): ConfigFinding {
  return { level: 'error', code, message };
}

function hasSourceType(source: unknown): boolean {
  return isPlainObject(source) && isNonEmptyString((source as Record<string, unknown>).type);
}

/**
 * Valida la forma de contract.budget: debe ser objeto con max_tokens number > 0.
 */
function validateBudget(budget: unknown): ConfigFinding[] {
  const f: ConfigFinding[] = [];
  if (!isPlainObject(budget)) {
    f.push(err('BUDGET_MISSING', 'falta contract.budget'));
    return f;
  }
  const mt = (budget as Record<string, unknown>).max_tokens;
  if (typeof mt !== 'number' || !(mt > 0)) {
    f.push(err('BUDGET_MAX_TOKENS_INVALID', 'contract.budget.max_tokens debe ser number > 0'));
  }
  return f;
}

/**
 * Valida la forma de un slot individual: id (string no vacío), priority (number),
 * compaction (válida) y source.type (string no vacío).
 */
function validateSlotShape(slot: unknown, i: number): ConfigFinding[] {
  const f: ConfigFinding[] = [];
  if (!isPlainObject(slot)) {
    f.push(err('SLOT_NOT_OBJECT', `slot[${i}] no es objeto`));
    return f;
  }
  const s = slot as Record<string, unknown>;
  if (!isNonEmptyString(s.id)) f.push(err('SLOT_MISSING_ID', `slot[${i}] sin id`));
  if (typeof s.priority !== 'number') f.push(err('SLOT_MISSING_PRIORITY', `slot[${i}] sin priority`));
  if (!COMPACTIONS.includes(s.compaction as string)) {
    f.push(err('SLOT_MISSING_COMPACTION', `slot[${i}] sin compaction válida`));
  }
  if (!hasSourceType(s.source)) f.push(err('SLOT_MISSING_SOURCE_TYPE', `slot[${i}] sin source.type`));
  return f;
}

/**
 * Valida la FORMA del contrato parseado. Devuelve findings de error:
 *  - no es objeto / falta contract interno
 *  - falta contract.budget.max_tokens (number > 0)
 *  - slots no es array no-vacío
 *  - algún slot sin id / priority / compaction / source.type
 */
export function validateContractShape(contract: unknown): ConfigFinding[] {
  const findings: ConfigFinding[] = [];

  if (!isPlainObject(contract)) {
    findings.push(err('CONTRACT_NOT_OBJECT', 'contract debe ser un objeto'));
    return findings;
  }

  const inner = (contract as Record<string, unknown>).contract;
  if (!isPlainObject(inner)) {
    findings.push(err('CONTRACT_MISSING_INNER', 'falta contract (objeto interno)'));
    return findings;
  }

  findings.push(...validateBudget((inner as Record<string, unknown>).budget));

  const slots = (inner as Record<string, unknown>).slots;
  if (!Array.isArray(slots) || slots.length === 0) {
    findings.push(err('SLOTS_EMPTY', 'contract.slots debe ser un array no vacío'));
    return findings;
  }

  slots.forEach((slot, i) => findings.push(...validateSlotShape(slot, i)));
  return findings;
}

/**
 * Mapea el contrato parseado al AssemblyConfig que consume el ensamblador.
 * Convierte snake_case (yaml) a camelCase (TS): max_tokens->maxTokens,
 * source.type->sourceType, on_fail->onFail, schema_path->schemaPath, target_slot->targetSlot.
 */
export function contractToAssemblyConfig(contract: any): AssemblyConfig {
  const inner = contract.contract;
  const budget = inner.budget;
  const slots: SlotConfig[] = inner.slots.map((s: any) => ({
    id: s.id,
    priority: s.priority,
    maxTokens: s.max_tokens,
    compaction: s.compaction,
    sourceType: s.source.type,
    path: s.source.path,
    provider: s.source.provider,
  }));
  const guardrails: GuardrailConfig[] = (inner.guardrails ?? []).map((g: any) => ({
    id: g.id,
    type: g.type,
    pattern: g.pattern,
    onFail: g.on_fail,
    schemaPath: g.schema_path,
    targetSlot: g.target_slot,
  }));
  return {
    totalBudget: budget.max_tokens,
    reserveOutput: budget.reserve_output ?? 0,
    slots,
    guardrails,
  };
}

/**
 * Mapea cfg.slots a la forma SlotInput que assembleContext espera, usando contents[slotId]
 * como content (string ya resuelto del slot; '' si falta). Mantiene el orden de cfg.slots.
 */
export function slotsForAssembler(
  cfg: AssemblyConfig,
  contents: Record<string, string>,
): SlotInput[] {
  return cfg.slots.map((s) => ({
    id: s.id,
    priority: s.priority,
    content: contents[s.id] ?? '',
    maxTokens: s.maxTokens,
    compaction: s.compaction,
  }));
}