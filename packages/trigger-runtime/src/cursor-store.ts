// Cursor-store: persistencia (fuera del proceso) del set `seen` de dedup
// por triggerId, para que el loop reactivo sobreviva a reinicios del runner.
//
// Dos implementaciones:
//   - MemoryCursorStore: el comportamiento original (seen en memoria, se pierde
//     al reiniciar). Es el default para no romper a los callers existentes.
//   - FileCursorStore(dir): persiste `seen` por triggerId como un JSON array
//     en `<dir>/<triggerId>.json`. load() devuelve [] si no existe o si el
//     JSON esta corrupto (nunca crashea); save() escribe el array y crea el
//     dir si no existe.
//
// Ambas implementan la misma interfaz CursorStore. selectNewItems (dedup.ts)
// sigue siendo la fuente de verdad del cursor; el store solo lo conserva.

import { promises as fs } from "node:fs";
import path from "node:path";

export interface CursorStore {
  load(triggerId: string): Promise<string[]>;
  save(triggerId: string, seen: string[]): Promise<void>;
}

/**
 * CursorStore en memoria (comportamiento original). No persiste: al reiniciar
 * el runner el cursor se pierde y los items viejos se re-disparan. Default
 * para retrocompatibilidad.
 */
export class MemoryCursorStore implements CursorStore {
  private map = new Map<string, string[]>();

  async load(triggerId: string): Promise<string[]> {
    return this.map.get(triggerId) ?? [];
  }

  async save(triggerId: string, seen: string[]): Promise<void> {
    // Copia defensiva: el caller muta `seen` in-place entre ticks; si
    // guardaramos la misma ref, un save posterior mutaria el snapshot.
    this.map.set(triggerId, [...seen]);
  }
}

/**
 * CursorStore en disco: `<dir>/<triggerId>.json` contiene el array de keys.
 * Sobrevive reinicios del proceso. load() es tolerante a archivos faltantes
 * o corruptos (devuelve [] en vez de lanzar). save() crea el dir si no existe.
 */
export class FileCursorStore implements CursorStore {
  constructor(private readonly dir: string) {}

  private file(triggerId: string): string {
    // triggerId puede venir con caracteres de ruta en tests adversariales;
    // lo saneamos quedandonos con el basename para no escapar del dir.
    const safe = path.basename(triggerId);
    return path.join(this.dir, `${safe}.json`);
  }

  async load(triggerId: string): Promise<string[]> {
    try {
      const raw = await fs.readFile(this.file(triggerId), "utf8");
      const parsed: unknown = JSON.parse(raw);
      // Solo confiamos en un array de strings; cualquier otra forma (objeto,
      // numero, array heterogeneo) se trata como cursor corrupto -> [].
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        return parsed as string[];
      }
      return [];
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      // Archivo inexistente -> cursor vacio (caso normal en el primer arranque).
      if (code === "ENOENT") return [];
      // JSON corrupto (SyntaxError) u otro error de lectura -> [] sin crashear.
      return [];
    }
  }

  async save(triggerId: string, seen: string[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = this.file(triggerId) + ".tmp";
    // Escritura atomica: escribe a un tmp y renombra, para no dejar un
    // cursor a medio escribir si el proceso muere a mitad del save.
    await fs.writeFile(tmp, JSON.stringify(seen), "utf8");
    await fs.rename(tmp, this.file(triggerId));
  }
}
