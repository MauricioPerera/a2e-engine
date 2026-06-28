// assemble-agent-context — Ensambla EN RUNTIME el contexto del agente A2E
// respetando el contrato CCDD (slots firmados + budget + guardrails).
//
// Lee los slots ESTÁTICOS del contrato (env.txt, system.txt, policies.md,
// flow-schema.txt) de CONTRACT_DIR, resuelve los slots DINÁMICOS via los
// providers (okf-retriever para catalog, connection-provider + vault para
// connections), toma user_message de la query, y delega el acotado por
// budget/prioridad a context-assembler.assembleContext (lógica PURA).
// Finalmente aplica el guardrail no-secrets sobre el contexto ensamblado.
//
// No es PURA (lee FS + vault), pero toda la lógica de budget/compaction vive
// en context-assembler (pura). Este módulo es glue de runtime + providers.

import path from "node:path";
import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assembleContext,
  applyRegexGuardrail,
  type SlotInput,
  type SlotResult,
} from "../../context-assembler/src/context-assembler.js";
import { retrieve } from "../../okf-retriever/src/okf-retriever.js";
import { renderConnectionRefs } from "../../connection-provider/src/connection-provider.js";
import { getVault, PROJECT_ID } from "./mock-backend.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Default: ~/product/contract. Override via env CONTRACT_DIR.
const DEFAULT_CONTRACT_DIR = path.join(os.homedir(), "product/contract");
const CONTRACT_DIR = process.env.CONTRACT_DIR ?? DEFAULT_CONTRACT_DIR;

// catalog-summary.json: mismo default que handlers.loadCatalogSummary.
const DEFAULT_CATALOG_SUMMARY = path.resolve(
  HERE,
  "../../okf-retriever/catalog-summary.json",
);
const CATALOG_SUMMARY_PATH = process.env.CATALOG_SUMMARY ?? DEFAULT_CATALOG_SUMMARY;

// --- Config de slots HARDCODEADO que COINCIDE con contract/context.yaml ----------
// Si se modifica context.yaml (prioridades/maxTokens/compaction), actualizar aquí.
// (No se parsea YAML para no añadir una dependencia; el contrato es la fuente
// de verdad y este config es un espejo firmado de sus slots.)
const TOTAL_BUDGET = 16000;
const RESERVE_OUTPUT = 4000;

interface SlotSpec {
  id: string;
  priority: number;
  compaction: "none" | "summarize" | "truncate";
  maxTokens?: number;
  staticPath?: string; // para slots estáticos: relativo a CONTRACT_DIR
}

const SLOT_SPECS: SlotSpec[] = [
  { id: "environment", priority: 0, compaction: "none", staticPath: "env.txt" },
  { id: "system", priority: 1, compaction: "none", staticPath: "system.txt" },
  { id: "policies", priority: 1, compaction: "none", staticPath: "policies.md" },
  { id: "flow_schema", priority: 2, compaction: "none", staticPath: "flow-schema.txt" },
  { id: "catalog", priority: 3, compaction: "summarize", maxTokens: 6000 },
  { id: "connections", priority: 3, compaction: "truncate", maxTokens: 1000 },
  { id: "user_message", priority: 4, compaction: "truncate" },
];

// Guardrail no-secrets del contrato (context.yaml guardrails[0]). HARDCODEADO
// que COINCIDE con context.yaml; actualizar ahí si cambia.
const NO_SECRETS_PATTERN =
  "(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)";

export interface AssembleAgentContextParams {
  query: string;
  projectId?: string;
}

export interface AssembleAgentContextResult {
  context: string;
  slots: SlotResult[];
  totalTokens: number;
  budget: number;
  withinBudget: boolean;
  dropped: string[];
  guardrail: { ok: boolean; matched: boolean };
}

function readStaticSlot(spec: SlotSpec): string {
  if (!spec.staticPath) return "";
  const full = path.join(CONTRACT_DIR, spec.staticPath);
  if (!existsSync(full)) {
    throw new Error(`contract slot ${spec.id}: missing file ${full}`);
  }
  return readFileSync(full, "utf8");
}

function loadCatalogSummary(): unknown[] | null {
  try {
    if (!existsSync(CATALOG_SUMMARY_PATH)) return null;
    return JSON.parse(readFileSync(CATALOG_SUMMARY_PATH, "utf8")) as unknown[];
  } catch (e) {
    console.error(
      `[assemble-agent-context] failed to load catalog-summary: ${(e as Error).message}`,
    );
    return null;
  }
}

/**
 * Ensamina el contexto del agente A2E en runtime:
 * 1. Lee slots estáticos del contrato (CONTRACT_DIR).
 * 2. catalog: okf-retriever.retrieve(summary, query, {maxTokens:6000, mode:"index"}).
 * 3. connections: vault.listReferences(projectId) -> renderConnectionRefs({maxTokens:1000}).
 * 4. user_message: la query.
 * 5. assembleContext(slots, {totalBudget:16000, reserveOutput:4000}).
 * 6. applyRegexGuardrail(context, NO_SECRETS_PATTERN).
 *
 * Lanza si un slot estático del contrato no existe o falta catalog-summary
 * (el contrato está firmado; un provider faltante es error fatal, no 503).
 */
export function assembleAgentContext(
  params: AssembleAgentContextParams,
): AssembleAgentContextResult {
  const query = params.query ?? "";
  const projectId = params.projectId ?? PROJECT_ID;

  // --- slots dinámicos (providers) ---
  const summary = loadCatalogSummary();
  if (!summary) {
    throw new Error(
      "catalog-summary.json not built. Run: node packages/okf-retriever/build-catalog-summary.mjs",
    );
  }
  const catalogCtx = retrieve(summary as never[], query, {
    maxTokens: 6000,
    mode: "index",
  }).context;

  const vault = getVault();
  if (!vault) {
    throw new Error("vault not initialized");
  }
  const refs = vault.listReferences(projectId).map((r) => ({
    externalId: r.externalId,
    displayName: r.displayName,
    pieceName: r.pieceName,
    type: r.type,
  }));
  const connectionsCtx = renderConnectionRefs(refs, { maxTokens: 1000 }).context;

  // --- Construye SlotInput[] con el config firmado ---
  const slots: SlotInput[] = SLOT_SPECS.map((spec) => {
    let content: string;
    switch (spec.id) {
      case "catalog":
        content = catalogCtx;
        break;
      case "connections":
        content = connectionsCtx;
        break;
      case "user_message":
        content = query;
        break;
      default:
        content = readStaticSlot(spec);
    }
    return {
      id: spec.id,
      priority: spec.priority,
      content,
      compaction: spec.compaction,
      ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}),
    };
  });

  // --- Ensambla por budget/prioridad (lógica pura en context-assembler) ---
  const assembly = assembleContext(slots, {
    totalBudget: TOTAL_BUDGET,
    reserveOutput: RESERVE_OUTPUT,
  });

  // --- Guardrail no-secrets sobre el contexto ensamblado ---
  const guardrail = applyRegexGuardrail(assembly.context, NO_SECRETS_PATTERN);

  return {
    context: assembly.context,
    slots: assembly.slots,
    totalTokens: assembly.totalTokens,
    budget: assembly.budget,
    withinBudget: assembly.withinBudget,
    dropped: assembly.dropped,
    guardrail,
  };
}
