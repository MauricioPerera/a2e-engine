// assemble-agent-context — Ensambla EN RUNTIME el contexto del agente A2E
// respetando el CONTRATO CCDD firmado (contract/context.yaml), que es la
// AUTORIDAD de runtime: budget, slots (prioridades/maxTokens/compaction),
// sources y guardrails se leen del yaml — NO hay config hardcodeado.
//
// Flujo:
//   1. Lee contract/context.yaml (CONTRACT_DIR, env override) y lo parsea con
//      js-yaml -> objeto.
//   2. validateContractShape: si hay errores de forma, lanza "invalid contract".
//   3. cfg = contractToAssemblyConfig(parsed): totalBudget, reserveOutput, slots,
//      guardrails (todo del yaml).
//   4. Para cada slot de cfg resuelve su CONTENT segun sourceType:
//        static    -> readFileSync(path relativo a CONTRACT_DIR)
//        dynamic   -> okf_catalog: okf-retriever.retrieve(summary, query, {maxTokens})
//                  -> connection_refs: renderConnectionRefs(vault.listReferences, {maxTokens})
//        runtime   -> la query
//      -> contents: { slotId: string }.
//   5. slotsForAssembler(cfg, contents) -> assembleContext(slots, {totalBudget, reserveOutput}).
//   6. Guardrail no-secrets: aplica applyRegexGuardrail con el pattern DEL CONTRATO
//      (guardrail type regex_deny del yaml), no hardcodeado.
//
// No es PURA (lee FS + yaml + vault), pero toda la lógica de budget/compaction vive
// en context-assembler (pura). Este módulo es glue de runtime + providers, y el
// contrato firmado (que L1/L2 gatean) es la autoridad que gobierna el ensamblado.

import path from "node:path";
import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load as yamlLoad } from "js-yaml";
import {
  assembleContext,
  applyRegexGuardrail,
  type SlotInput,
  type SlotResult,
} from "../../context-assembler/src/context-assembler.js";
import {
  validateContractShape,
  contractToAssemblyConfig,
  slotsForAssembler,
  type AssemblyConfig,
} from "../../context-assembler/src/contract-config.js";
import { retrieve } from "../../okf-retriever/src/okf-retriever.js";
import { renderConnectionRefs } from "../../connection-provider/src/connection-provider.js";
import type { Vault } from "../../backend-mock/src/vault.js";
import { getVault, PROJECT_ID } from "./mock-backend.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Default: ~/product/contract. Override via env CONTRACT_DIR. Se lee EN CADA
// llamada (no a module-load) para que el contrato sea autoridad de runtime: si
// CONTRACT_DIR apunta a otro yaml (o el yaml se edita), la siguiente petición
// lo refleja sin reiniciar el proceso.
const DEFAULT_CONTRACT_DIR = path.join(os.homedir(), "product/contract");
function contractDir(): string {
  return process.env.CONTRACT_DIR ?? DEFAULT_CONTRACT_DIR;
}

// catalog-summary.json: mismo default que handlers.loadCatalogSummary.
const DEFAULT_CATALOG_SUMMARY = path.resolve(
  HERE,
  "../../okf-retriever/catalog-summary.json",
);
const CATALOG_SUMMARY_PATH = process.env.CATALOG_SUMMARY ?? DEFAULT_CATALOG_SUMMARY;

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
 * Lee y parsea contract/context.yaml (CONTRACT_DIR) con js-yaml. Valida la forma
 * con validateContractShape; si hay errores, lanza "invalid contract: ...".
 * Devuelve el contrato parseado (objeto) o lanza.
 */
function loadContract(): unknown {
  const contractPath = path.join(contractDir(), "context.yaml");
  if (!existsSync(contractPath)) {
    throw new Error(`invalid contract: missing ${contractPath}`);
  }
  let parsed: unknown;
  try {
    parsed = yamlLoad(readFileSync(contractPath, "utf8"));
  } catch (e) {
    throw new Error(`invalid contract: failed to parse ${contractPath}: ${(e as Error).message}`);
  }
  const findings = validateContractShape(parsed);
  if (findings.length > 0) {
    const msgs = findings.map((f) => `${f.code}: ${f.message}`).join("; ");
    throw new Error(`invalid contract: ${msgs}`);
  }
  return parsed;
}

/**
 * Resuelve el CONTENT (string) de un slot de cfg segun su sourceType:
 *  - static: lee el archivo (slot.path relativo a CONTRACT_DIR).
 *  - dynamic: provider okf_catalog -> okf-retriever.retrieve; provider connection_refs
 *    -> renderConnectionRefs(vault.listReferences(projectId)). maxTokens del slot.
 *  - runtime: la query.
 * Lanza si el sourceType/provider es desconocido o falta un archivo estático.
 */
function resolveSlotContent(
  slot: AssemblyConfig["slots"][number],
  ctx: {
    query: string;
    projectId: string;
    summary: unknown[];
    refs: ReturnType<Vault["listReferences"]>;
    totalBudget: number;
  },
): string {
  switch (slot.sourceType) {
    case "static": {
      if (!slot.path) {
        throw new Error(`invalid contract: slot ${slot.id} static sin source.path`);
      }
      const full = path.join(contractDir(), slot.path);
      if (!existsSync(full)) {
        throw new Error(`invalid contract: slot ${slot.id} missing file ${full}`);
      }
      return readFileSync(full, "utf8");
    }
    case "dynamic": {
      // maxTokens del slot (yaml). Si el yaml no fija max_tokens para un slot
      // dinámico, cae al budget total del contrato (también del yaml): ningún
      // magic number hardcodeado aquí.
      const maxTokens = slot.maxTokens ?? ctx.totalBudget;
      if (slot.provider === "okf_catalog") {
        return retrieve(ctx.summary as never[], ctx.query, {
          maxTokens,
          mode: "index",
        }).context;
      }
      if (slot.provider === "connection_refs") {
        return renderConnectionRefs(ctx.refs, { maxTokens }).context;
      }
      throw new Error(`invalid contract: slot ${slot.id} dynamic provider desconocido: ${slot.provider}`);
    }
    case "runtime":
      return ctx.query;
    default:
      throw new Error(`invalid contract: slot ${slot.id} sourceType desconocido: ${slot.sourceType}`);
  }
}

/**
 * Ensamina el contexto del agente A2E en runtime, gobernado por contract/context.yaml:
 * 1. loadContract() -> yaml parseado + validado.
 * 2. cfg = contractToAssemblyConfig(parsed).
 * 3. contents por slot (static/dynamic/runtime).
 * 4. slotsForAssembler(cfg, contents) -> assembleContext({totalBudget, reserveOutput}).
 * 5. applyRegexGuardrail con el pattern del guardrail regex_deny DEL CONTRATO.
 *
 * Lanza "invalid contract: ..." si el yaml no existe, no parsea o falla la forma.
 * Lanza si un slot estático del contrato no existe o falta catalog-summary
 * (el contrato está firmado; un provider faltante es error fatal, no 503).
 */
export function assembleAgentContext(
  params: AssembleAgentContextParams,
): AssembleAgentContextResult {
  const query = params.query ?? "";
  const projectId = params.projectId ?? PROJECT_ID;

  // --- contrato: autoridad de runtime ---
  const parsed = loadContract();
  const cfg = contractToAssemblyConfig(parsed);

  // --- providers para slots dinámicos ---
  const summary = loadCatalogSummary();
  if (!summary) {
    throw new Error(
      "catalog-summary.json not built. Run: node packages/okf-retriever/build-catalog-summary.mjs",
    );
  }
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

  // --- contents por slot, segun sourceType del yaml ---
  const resolveCtx = { query, projectId, summary, refs, totalBudget: cfg.totalBudget };
  const contents: Record<string, string> = {};
  for (const slot of cfg.slots) {
    contents[slot.id] = resolveSlotContent(slot, resolveCtx);
  }

  // --- SlotInput[] desde el cfg + contents (slotsForAssembler) ---
  const slotInputs: SlotInput[] = slotsForAssembler(cfg, contents);

  // --- Ensambla por budget/prioridad (lógica pura en context-assembler) ---
  const assembly = assembleContext(slotInputs, {
    totalBudget: cfg.totalBudget,
    reserveOutput: cfg.reserveOutput,
  });

  // --- Guardrail no-secrets: pattern DEL CONTRATO (regex_deny), no hardcodeado ---
  const noSecrets = cfg.guardrails.find((g) => g.type === "regex_deny");
  if (!noSecrets || !noSecrets.pattern) {
    throw new Error("invalid contract: falta guardrail regex_deny (no-secrets) con pattern");
  }
  const guardrail = applyRegexGuardrail(assembly.context, noSecrets.pattern);

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