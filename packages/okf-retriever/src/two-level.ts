// two-level — Retriever jerárquico de 2 niveles del catálogo OKF.
//
// Nivel 1: pieces relevantes + NOMBRES de sus actions (hints, sin props).
// Nivel 2: las actions DE UNA piece, filtradas por query, con props.
// Cada nivel acotado a su propio budget de tokens.
//
// Sin red, sin FS, sin Date. Todo funciones puras. Reusa estimateTokens y
// scorePiece de okf-retriever; el resto es local y autónomo.

import { estimateTokens, scorePiece, type PieceSummary } from './okf-retriever.js';

/**
 * Detalle de una action: metadatos + props estructuradas.
 */
export type ActionDetail = {
  name: string;
  displayName?: string;
  description: string;
  requireAuth?: boolean;
  props?: { name: string; type: string; required: boolean; description?: string }[];
};

/**
 * Hint de nivel 1: una piece con los NOMBRES de sus actions (sin props).
 */
export type PieceHint = {
  name: string;
  displayName: string;
  description: string;
  auth?: string;
  actionNames: string[];
};

/**
 * Resultado de un nivel: contexto renderizado + cobertura + tokens.
 */
export type LevelResult = {
  context: string;
  included: string[];
  total: number;
  omitted: number;
  estimatedTokens: number;
};

// Stopwords básicas (EN + ES) para que la tokenización no se llene de ruido.
const STOPWORDS = new Set<string>([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with',
  'is', 'are', 'at', 'by', 'from', 'as', 'be', 'this', 'that', 'it',
  'el', 'la', 'de', 'en', 'y', 'o', 'para', 'con', 'por', 'un', 'una',
  'los', 'las', 'del', 'que',
]);

// Pesos de coincidencia para scoreAction: name/displayName pesan más que description.
const WEIGHT_NAME = 3;
const WEIGHT_DESC = 1;

const MAX_LISTED_ACTIONS = 12;

/**
 * Tokeniza la query: lowercase, split por no-alfanumérico, descarta vacíos y
 * stopwords básicas.
 */
export function tokenize(query: string): string[] {
  const raw = query.toLowerCase().split(/[^a-z0-9]+/);
  const terms: string[] = [];
  for (const t of raw) {
    if (t.length > 0 && !STOPWORDS.has(t)) terms.push(t);
  }
  return terms;
}

/**
 * Trunca un texto a max chars agregando elipsis si excede.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function byScoreDescStable(
  a: { s: number; i: number },
  b: { s: number; i: number },
): number {
  return b.s - a.s || a.i - b.i; // desc por score, empate estable por índice
}

/**
 * Renderiza el hint de nivel 1 de una piece: name, auth, descripción acotada y
 * la lista de NOMBRES de actions (sin props). Hasta ~12 nombres; si hay más,
 * agrega "+N more".
 */
export function renderPieceHint(p: {
  name: string;
  displayName: string;
  description: string;
  auth?: string;
  actions: { name: string }[];
}): string {
  const auth = p.auth ?? 'no-auth';
  const desc = truncate(p.description, 80);
  const names = p.actions.map((a) => a.name);
  const shown = names.slice(0, MAX_LISTED_ACTIONS);
  const tail = names.length > MAX_LISTED_ACTIONS ? ` +${names.length - MAX_LISTED_ACTIONS} more` : '';
  return `- ${p.name} (${auth}): ${desc} | actions: ${shown.join(', ')}${tail}`;
}

/**
 * NIVEL 1: selecciona y renderiza las pieces relevantes (con NOMBRES de actions)
 * que caben en maxTokens.
 *  - Query vacía o sin terms: todas ordenadas por name (fallback).
 *  - Sino: puntúa con scorePiece, descarta score 0, ordena desc (estable).
 *  - Incluye en orden mientras estimateTokens(contexto acumulado) <= maxTokens.
 */
export function retrievePieces(
  pieces: PieceSummary[],
  query: string,
  opts: { maxTokens: number },
): LevelResult {
  const terms = tokenize(query);
  const candidates =
    terms.length === 0
      ? [...pieces].sort(byName)
      : pieces
          .map((p, i) => ({ p, s: scorePiece(p, terms), i }))
          .filter((x) => x.s > 0)
          .sort(byScoreDescStable)
          .map((x) => x.p);

  let context = '';
  const included: string[] = [];
  for (const cand of candidates) {
    const hint = renderPieceHint(cand);
    const candidateContext = context.length === 0 ? hint : context + '\n' + hint;
    if (estimateTokens(candidateContext) > opts.maxTokens) break;
    context = candidateContext;
    included.push(cand.name);
  }

  const total = candidates.length;
  const omitted = total - included.length;
  return {
    context,
    included,
    total,
    omitted,
    estimatedTokens: estimateTokens(context),
  };
}

/**
 * Puntúa una action por coincidencia (case-insensitive) de los terms en
 * name, displayName y description. Más peso a name/displayName que a description.
 * 0 si no matchea nada.
 */
export function scoreAction(a: ActionDetail, terms: string[]): number {
  if (terms.length === 0) return 0;
  const nameField = (a.name + ' ' + (a.displayName ?? '')).toLowerCase();
  const desc = a.description.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (nameField.includes(term)) score += WEIGHT_NAME;
    if (desc.includes(term)) score += WEIGHT_DESC;
  }
  return score;
}

/**
 * Renderiza el detalle de nivel 2 de una action: cabecera + descripción +
 * tabla de props. Si no hay props, "_no props_".
 */
export function renderActionDetail(a: ActionDetail): string {
  const head = `### ${a.name}`;
  const body = a.description;
  if (!a.props || a.props.length === 0) {
    return `${head}\n${body}\n_no props_`;
  }
  const header = '| prop | type | required |';
  const sep = '|------|------|----------|';
  const rows = a.props.map((p) => `| ${p.name} | ${p.type} | ${p.required} |`);
  return `${head}\n${body}\n${header}\n${sep}\n${rows.join('\n')}`;
}

/**
 * NIVEL 2: selecciona y renderiza las actions DE UNA piece que caben en
 * maxTokens.
 *  - Query undefined o '': todas en orden original.
 *  - Sino: scoreAction, descarta 0, ordena desc (estable).
 *  - Incluye en orden mientras estimateTokens(contexto acumulado) <= maxTokens.
 */
export function retrieveActions(
  actions: ActionDetail[],
  query: string | undefined,
  opts: { maxTokens: number },
): LevelResult {
  const hasQuery = query !== undefined && query.trim().length > 0;
  const terms = hasQuery ? tokenize(query as string) : [];
  const effectiveTerms = terms.length > 0 ? terms : [];
  const candidates =
    hasQuery && effectiveTerms.length > 0
      ? actions
          .map((a, i) => ({ a, s: scoreAction(a, effectiveTerms), i }))
          .filter((x) => x.s > 0)
          .sort(byScoreDescStable)
          .map((x) => x.a)
      : actions;

  let context = '';
  const included: string[] = [];
  for (const cand of candidates) {
    const block = renderActionDetail(cand);
    const candidateContext = context.length === 0 ? block : context + '\n' + block;
    if (estimateTokens(candidateContext) > opts.maxTokens) break;
    context = candidateContext;
    included.push(cand.name);
  }

  const total = candidates.length;
  const omitted = total - included.length;
  return {
    context,
    included,
    total,
    omitted,
    estimatedTokens: estimateTokens(context),
  };
}