// connection-provider.ts
// Lógica PURA de render acotado a budget para el slot `connections` del CCDD.
// Solo REFERENCIAS de credenciales (nombre, piece, tipo de auth) — NUNCA secretos.
// Sin red/FS/Date/secretos.

export interface ConnectionRef {
  externalId: string;
  displayName: string;
  pieceName: string;
  type: string; // SECRET_TEXT | CUSTOM_AUTH | OAUTH2 | ...
}

export interface RenderOptions {
  maxTokens: number;
  pieceName?: string;
}

export interface RenderResult {
  context: string;
  included: string[];
  total: number;
  omitted: number;
}

const HEADER = "Available connections:";

/**
 * Estima el costo en tokens de un texto (aproximación length/4, redondeado hacia arriba).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Filtra las referencias por pieceName. Si pieceName no se da, devuelve todas.
 */
export function filterByPiece(refs: ConnectionRef[], pieceName?: string): ConnectionRef[] {
  if (pieceName === undefined) return refs;
  return refs.filter((r) => r.pieceName === pieceName);
}

/**
 * Renderiza UNA referencia como línea de contexto.
 * Solo la REFERENCIA `{{connections.<externalId>}}` — nunca un secreto.
 */
export function renderRefLine(ref: ConnectionRef): string {
  return `- {{connections.${ref.externalId}}} — ${ref.displayName} (${ref.pieceName}, auth: ${ref.type})`;
}

/**
 * Filtra por piece y recorta para que el render quepa en maxTokens.
 * Estima incrementalmente: detiene cuando agregar la siguiente excede el budget.
 */
export function renderConnectionRefs(refs: ConnectionRef[], opts: RenderOptions): RenderResult {
  const filtered = filterByPiece(refs, opts.pieceName);
  const total = filtered.length;

  let context = HEADER;
  let used = estimateTokens(context);
  const included: string[] = [];

  for (const ref of filtered) {
    const line = renderRefLine(ref);
    // Separador de línea entre el contexto acumulado y la nueva línea.
    const added = (context.length === 0 ? "" : "\n") + line;
    const addedTokens = estimateTokens(added);
    if (used + addedTokens > opts.maxTokens) break;
    context += added;
    used += addedTokens;
    included.push(ref.externalId);
  }

  return {
    context,
    included,
    total,
    omitted: total - included.length,
  };
}