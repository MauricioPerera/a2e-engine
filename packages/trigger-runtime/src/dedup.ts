// Deduplicación pura para triggers POLLING.
// Sin red, sin estado global, sin Date. Solo lógica determinista de cursor.

/**
 * Stringify determinista: ordena las claves de los objetos recursivamente,
 * de modo que {a:1,b:2} y {b:2,a:1} produzcan la misma cadena.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((k) => {
    const v = (value as Record<string, unknown>)[k];
    return JSON.stringify(k) + ":" + stableStringify(v);
  });
  return "{" + parts.join(",") + "}";
}

/**
 * Devuelve una key estable para un item.
 * - Si el item es un objeto con propiedad `idField` (default "id") de valor
 *   primitivo (string/number/boolean), devuelve String(ese valor).
 * - Si no, devuelve el hash estable (stableStringify) del item.
 * - null/undefined -> "null"/"undefined".
 */
export function itemKey(item: unknown, idField: string = "id"): string {
  if (item === null || item === undefined) return String(item);
  if (typeof item === "object") {
    const v = (item as Record<string, unknown>)[idField];
    if (
      v !== undefined &&
      (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    ) {
      return String(v);
    }
  }
  return stableStringify(item);
}

/**
 * Deduplica items contra un cursor de keys ya vistas.
 * - newItems: items cuya key no estaba en `seen`, preservando el orden de
 *   aparición; si dos items del mismo batch comparten key, solo el primero
 *   cuenta como nuevo.
 * - seen (devuelto): union de `seen` previo + las keys de los newItems
 *   (sin duplicados, las nuevas al final, orden estable).
 * - No muta las entradas: devuelve arrays nuevos.
 */
export function selectNewItems(
  items: unknown[],
  seen: string[],
  idField?: string,
): { newItems: unknown[]; seen: string[] } {
  const seenSet = new Set(seen);
  const newItems: unknown[] = [];
  const addedKeys: string[] = [];
  for (const item of items) {
    const key = itemKey(item, idField);
    if (seenSet.has(key)) continue;
    seenSet.add(key);
    newItems.push(item);
    addedKeys.push(key);
  }
  return { newItems, seen: [...seen, ...addedKeys] };
}