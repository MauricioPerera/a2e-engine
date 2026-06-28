// action-md-parser — Parsers de action.md del full-catalog a ActionDetail.
// Puro: string -> ActionDetail. Sin red, sin FS (el caller lee el archivo y le
// pasa el contenido). Reusa el tipo ActionDetail del retriever de 2 niveles.
//
// Formato action.md (verificado en los 4938 action.md del full-catalog):
//   frontmatter YAML con `description` (una sola linea, entre comillas).
//   H1 `# <displayName>`.
//   seccion Reference: `- **action name:** \`<name>\`` y `- **requires auth:** yes|no`.
//   seccion `## Input properties` con tabla `| Property | Type | Required | Description |`.
import type { ActionDetail } from "../../okf-retriever/src/two-level.js";

// Extrae el bloque YAML de frontmatter (entre el primer --- y el siguiente ---).
function extractFrontmatter(md: string): string {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : "";
}

// Campo YAML de una sola linea (clave: valor). Soporta valores entre comillas
// dobles (con escapes \") o simples, y valores sin comillas. Las descriptions
// del full-catalog son siempre una sola linea.
function yamlField(fm: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*(.*)$`, "m");
  const m = fm.match(re);
  if (!m) return undefined;
  let v = m[1].trim();
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  } else if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") {
    v = v.slice(1, -1);
  }
  return v;
}

// Primer H1 (`# Title`) del markdown, sin el `#`. Es el displayName limpio (sin
// el prefijo de piece que lleva el title del frontmatter).
function extractH1(md: string): string | undefined {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1] : undefined;
}

// Nombre de la action desde la seccion Reference: `- **action name:** \`name\``.
// Fallback al nombre del archivo (sin .md) si falta la linea.
function extractActionName(md: string, filename: string): string {
  const m = md.match(/\*\*action name:\*\*\s*`([^`]+)`/);
  return m ? m[1] : filename.replace(/\.md$/i, "");
}

// requireAuth desde `- **requires auth:** yes|no`. undefined si no se encuentra.
function extractRequireAuth(md: string): boolean | undefined {
  const m = md.match(/\*\*requires auth:\*\*\s*(yes|no)\b/i);
  if (!m) return undefined;
  return m[1].toLowerCase() === "yes";
}

// Parsea una fila de tabla markdown `| \`prop\` | TYPE | req | desc |` en sus
// celdas. La descripcion (ultima celda) puede contener `|` literales: se rejoin
// para no cortarla. Devuelve null si la fila no tiene al menos name+type.
function parseRow(line: string): {
  name: string;
  type: string;
  required: boolean;
  description?: string;
} | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const raw = trimmed.split("|");
  // raw[0] === "" (antes del primer |), raw[last] === "" (despues del ultimo |)
  const cells = raw.slice(1, raw.length - 1).map((c) => c.trim());
  if (cells.length < 3) return null;
  const name = cells[0].replace(/^`|`$/g, "").trim();
  const type = cells[1].trim();
  const reqRaw = cells[2].trim().toLowerCase();
  const required = reqRaw === "yes" || reqRaw === "true";
  const desc = cells.slice(3).join("|").trim();
  if (!name || !type) return null;
  return { name, type, required, ...(desc ? { description: desc } : {}) };
}

// Parsea la tabla de `## Input properties` de un action.md en props[]. Cabecera
// exacta `| Property | Type | Required | Description |`, separador de guiones,
// luego filas. Devuelve undefined si no hay tabla o esta vacia.
export function parseProps(md: string): ActionDetail["props"] {
  const lines = md.split(/\r?\n/);
  let i = 0;
  // localiza la cabecera de la tabla de props
  for (; i < lines.length; i++) {
    if (/^\s*\|\s*Property\s*\|\s*Type\s*\|\s*Required\s*\|\s*Description\s*\|/.test(lines[i])) {
      i++;
      break;
    }
  }
  if (i === 0 || i >= lines.length) return undefined; // sin tabla
  // salta el separador (| --- | --- | ...)
  if (/^\s*\|[\s\-:|]+\|\s*$/.test(lines[i])) i++;
  const props: { name: string; type: string; required: boolean; description?: string }[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) break; // fin de la tabla
    if (/^\s*\|[\s\-:|]+\|\s*$/.test(line)) continue; // separador extra
    const row = parseRow(line);
    if (row) props.push(row);
  }
  return props.length > 0 ? props : undefined;
}

// Parsea un action.md completo a ActionDetail. Puro: recibe el contenido + nombre
// del archivo (fallback para el action name si falta la linea de Reference).
export function parseActionMd(content: string, filename: string): ActionDetail {
  const fm = extractFrontmatter(content);
  const description = yamlField(fm, "description") ?? "";
  const displayName = extractH1(content) ?? yamlField(fm, "title");
  const name = extractActionName(content, filename);
  const requireAuth = extractRequireAuth(content);
  const props = parseProps(content);
  return {
    name,
    ...(displayName ? { displayName } : {}),
    description,
    ...(requireAuth !== undefined ? { requireAuth } : {}),
    ...(props ? { props } : {}),
  };
}