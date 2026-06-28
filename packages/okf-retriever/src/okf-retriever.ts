// okf-retriever — Retriever estructural (sin RAG) del catálogo OKF.
//
// Dado un catálogo (resúmenes de pieces) + una query + un budget de tokens,
// selecciona el subconjunto MÁS RELEVANTE por coincidencia estructural de terms
// y lo renderiza como contexto compacto que cabe en el budget.
// Progressive disclosure: por defecto entrega el índice compacto; el agente puede
// pedir 'detail' para ver las actions de cada piece.
//
// Sin red, sin FS, sin Date. Todo funciones puras.

/**
 * Resumen estructural de una piece del catálogo OKF.
 */
export type PieceSummary = {
  name: string;
  displayName: string;
  description: string;
  tags?: string[];
  auth?: string;
  actions: { name: string; description: string }[];
};

export type RetrieveMode = 'index' | 'detail';

export type RetrieveOptions = { maxTokens: number; mode?: RetrieveMode };

export type RetrieveResult = {
  context: string;
  included: string[];
  estimatedTokens: number;
  total: number;
  omitted: number;
};

// Stopwords básicas (EN + ES) para que la tokenización no se llene de ruido.
const STOPWORDS = new Set<string>([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with',
  'is', 'are', 'at', 'by', 'from', 'as', 'be', 'this', 'that', 'it',
  'el', 'la', 'de', 'en', 'y', 'o', 'para', 'con', 'por', 'un', 'una',
  'los', 'las', 'del', 'que',
]);

// Pesos de coincidencia: name/displayName pesan más que description.
const WEIGHT_NAME = 3;
const WEIGHT_TAGS = 2;
const WEIGHT_DESC = 1;
const WEIGHT_ACTION = 1;

const NEWLINE_COST = 1; // estimateTokens('\n') === ceil(1/4) === 1

/**
 * Estima tokens de un texto vía heurística chars/4.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Puntúa una piece por coincidencia (case-insensitive) de los terms en
 * name, displayName, description, tags y nombres de actions.
 * Más peso a match en name/displayName que en description. 0 si no matchea nada.
 */
export function scorePiece(piece: PieceSummary, terms: string[]): number {
  if (terms.length === 0) return 0;
  const nameField = (piece.name + ' ' + piece.displayName).toLowerCase();
  const desc = piece.description.toLowerCase();
  const tags = (piece.tags ?? []).join(' ').toLowerCase();
  const actionNames = piece.actions.map((a) => a.name).join(' ').toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (nameField.includes(term)) score += WEIGHT_NAME;
    if (tags.includes(term)) score += WEIGHT_TAGS;
    if (desc.includes(term)) score += WEIGHT_DESC;
    if (actionNames.includes(term)) score += WEIGHT_ACTION;
  }
  return score;
}

/**
 * Tokeniza la query: split por no-alfanumérico, lowercase, descarta vacíos y stopwords.
 */
function tokenizeQuery(query: string): string[] {
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

/**
 * Header compacto del catálogo (independiente del count para que la estimación
 * incremental de budget sea coherente con renderCatalog).
 */
function renderHeader(mode: RetrieveMode): string {
  return `# okf-catalog (${mode})`;
}

/**
 * Línea compacta de índice para una piece (modo descubrimiento).
 */
export function renderPieceLine(piece: PieceSummary): string {
  const auth = piece.auth ?? 'no-auth';
  const desc = truncate(piece.description, 80);
  return `- ${piece.name} (${auth}): ${desc} [${piece.actions.length} actions]`;
}

/**
 * Bloque de detalle para una piece: cabecera + descripción + sus actions.
 */
export function renderPieceDetail(piece: PieceSummary): string {
  const auth = piece.auth ?? 'no-auth';
  const head = `## ${piece.name} (${auth}) — ${piece.displayName}`;
  const actions = piece.actions
    .map((a) => `  - ${a.name} — ${truncate(a.description, 100)}`)
    .join('\n');
  return `${head}\n${piece.description}\nActions:\n${actions}`;
}

/**
 * Renderiza el catálogo según el modo:
 *  - 'index': header + una línea compacta por piece (para descubrir).
 *  - 'detail': header + bloque con actions por piece.
 */
export function renderCatalog(pieces: PieceSummary[], mode: RetrieveMode): string {
  const lines = pieces.map(mode === 'detail' ? renderPieceDetail : renderPieceLine);
  return [renderHeader(mode), ...lines].join('\n');
}

/**
 * Recorta la lista ordenada para que renderCatalog(resultado, mode) quepa en
 * maxTokens. Estima incrementalmente deteniéndose cuando la siguiente piece
 * excedería el budget. El conteo de chars espeja exactamente renderCatalog,
 * por lo que estimateTokens(renderCatalog(out, mode)) === ceil(totalChars/4).
 */
function trimByBudget(
  pieces: PieceSummary[],
  mode: RetrieveMode,
  maxTokens: number,
): PieceSummary[] {
  const out: PieceSummary[] = [];
  const header = renderHeader(mode);
  let totalChars = header.length + NEWLINE_COST; // header + '\n' inicial
  for (const piece of pieces) {
    const line = mode === 'detail' ? renderPieceDetail(piece) : renderPieceLine(piece);
    const sep = out.length > 0 ? NEWLINE_COST : 0;
    const newTotal = totalChars + sep + line.length;
    if (Math.ceil(newTotal / 4) > maxTokens) break;
    totalChars = newTotal;
    out.push(piece);
  }
  return out;
}

function byName(a: PieceSummary, b: PieceSummary): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function byScoreDesc(
  a: { p: PieceSummary; s: number; i: number },
  b: { p: PieceSummary; s: number; i: number },
): number {
  return b.s - a.s || a.i - b.i; // desc por score, empate estable por índice
}

/**
 * Selecciona el subconjunto más relevante que cabe en el budget.
 *  - Query vacía o sin terms: devuelve todas ordenadas por name (fallback).
 *  - Sino: puntúa, descarta score 0, ordena desc por score (estable) y recorta
 *    para que renderCatalog(resultado, mode) quepa en maxTokens.
 */
export function selectPieces(
  pieces: PieceSummary[],
  query: string,
  opts: RetrieveOptions,
): PieceSummary[] {
  const mode = opts.mode ?? 'index';
  const terms = tokenizeQuery(query);
  if (terms.length === 0) {
    return trimByBudget([...pieces].sort(byName), mode, opts.maxTokens);
  }
  const ranked = pieces
    .map((p, i) => ({ p, s: scorePiece(p, terms), i }))
    .filter((x) => x.s > 0)
    .sort(byScoreDesc)
    .map((x) => x.p);
  return trimByBudget(ranked, mode, opts.maxTokens);
}

/**
 * Punto de entrada del retriever: selecciona + renderiza + reporta cobertura.
 * Devuelve el contexto, los names incluidos, tokens estimados, total de pieces
 * que matcheaban y cuántas se omitieron por budget (para que el agente sepa
 * que hay más).
 */
export function retrieve(
  pieces: PieceSummary[],
  query: string,
  opts: RetrieveOptions,
): RetrieveResult {
  const mode = opts.mode ?? 'index';
  const terms = tokenizeQuery(query);
  const matching = terms.length === 0 ? pieces : pieces.filter((p) => scorePiece(p, terms) > 0);
  const selected = selectPieces(pieces, query, opts);
  const context = renderCatalog(selected, mode);
  return {
    context,
    included: selected.map((p) => p.name),
    estimatedTokens: estimateTokens(context),
    total: matching.length,
    omitted: matching.length - selected.length,
  };
}