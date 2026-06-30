// build-catalog-summary.mjs — Construye catalog-summary.json (array de PieceSummary)
// a partir de la metadata REAL del catálogo OKF en engine-adapter/full-catalog.
//
// Camino de indexado (robusto, 1 archivo por piece):
//   Para cada <piece>/index.md parseamos:
//     - frontmatter YAML: title (displayName), description, resource (name), tags
//     - sección Metadata: `- **auth:** <auth>`
//     - sección Actions: `- [Display Name](path) — description`  (hasta `## Triggers` o EOF)
//   No abrimos los ~7000 action.md: el index.md ya trae name+description de cada action,
//   que es lo que el retriever necesita para matching estructural y para que el agente
//   descubra. Esto evita 10x archivos y fragilidad extra.
//
// Uso: node build-catalog-summary.mjs [catalogRoot] [outPath]
//   catalogRoot default: ../engine-adapter/full-catalog
//   outPath    default: ./catalog-summary.json
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CATALOG_ROOT = resolve(process.argv[2] ?? join(__dirname, "../engine-adapter/full-catalog"));
const OUT_PATH = resolve(process.argv[3] ?? join(__dirname, "catalog-summary.json"));

// --- parsers mínimos (sin deps externas) -------------------------------------

/**
 * Parsea el frontmatter YAML limitado que usan los index.md de piece:
 * type, title, description, resource, tags. Devuelve {title, description, resource, tags}.
 */
function parseFrontmatter(md) {
  const fm = {};
  if (!md.startsWith("---")) return fm;
  const end = md.indexOf("\n---", 3);
  if (end === -1) return fm;
  const block = md.slice(3, end);
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      // array YAML: ["a", B, C]
      val = val.slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"))
        .filter((s) => s.length > 0);
    } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }
  return fm;
}

/**
 * Extrae `- **auth:** <value>` del bloque Metadata. Devuelve string | undefined.
 */
function parseAuth(md) {
  const m = md.match(/^\s*-\s*\*\*auth:\*\*\s*(.+?)\s*$/m);
  return m ? m[1].trim() : undefined;
}

/**
 * Parsea la sección `## Actions` (hasta `## Triggers` o EOF): cada línea
 * `- [Display Name](path) — description` -> {name, description}.
 * Acepta em dash (—), en dash (–) y guion simple como separador.
 */
function parseActions(md) {
  const actions = [];
  const head = md.indexOf("## Actions");
  if (head === -1) return actions;
  const tailTrigger = md.indexOf("## Triggers", head);
  const section = md.slice(head, tailTrigger === -1 ? undefined : tailTrigger);
  // `- [Name](path) [sep] desc`  — sep es —, – o - rodeado de espacios (o nada).
  const re = /^\s*-\s*\[([^\]]+)\]\([^)]+\)\s*(?:[—–-][\s\S]*)?\s*$/gm;
  // El regex anterior no captura desc cómodamente; usamos split manual por robustez.
  const lineRe = /^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*(.*)$/gm;
  let m;
  while ((m = lineRe.exec(section)) !== null) {
    const name = m[1].trim();
    let desc = m[3].trim();
    // quita separador inicial si lo hay (—, –, -)
    desc = desc.replace(/^[—–-]\s*/, "").trim();
    if (name.length > 0) actions.push({ name, description: desc });
  }
  return actions;
}

async function build() {
  // Multi-scope: escanea TODOS los dirs @<scope> bajo CATALOG_ROOT, no solo
  // @activepieces. Las pieces importadas (T2) viven bajo otros scopes (ej.
  // @automators/..., @promotest/...); antes solo se indexaba @activepieces y
  // el discovery nivel 1 (catalog-summary.json) las ignoraba. Cada scope se
  // recorre igual que antes: dirs piece-* con index.md.
  const scopeEntries = await readdir(CATALOG_ROOT, { withFileTypes: true });
  const scopes = scopeEntries
    .filter((e) => e.isDirectory() && e.name.startsWith("@"))
    .map((e) => e.name)
    .sort();

  const summary = [];
  let totalActions = 0;
  let skipped = 0;
  const scopesUsed = [];
  for (const scope of scopes) {
    const scopeDir = join(CATALOG_ROOT, scope);
    let entries = await readdir(scopeDir, { withFileTypes: true });
    entries = entries.filter((e) => e.isDirectory() && e.name.startsWith("piece-"));
    if (entries.length === 0) continue;
    scopesUsed.push(scope);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const idxPath = join(scopeDir, e.name, "index.md");
      let md;
      try {
        md = await readFile(idxPath, "utf8");
      } catch {
        skipped++;
        continue;
      }
      const fm = parseFrontmatter(md);
      const name = typeof fm.resource === "string" && fm.resource.length > 0 ? fm.resource : `${scope}/${e.name}`;
      const displayName = typeof fm.title === "string" && fm.title.length > 0 ? fm.title : e.name;
      const description = typeof fm.description === "string" ? fm.description : "";
      const tags = Array.isArray(fm.tags) ? fm.tags.filter((t) => typeof t === "string") : undefined;
      const auth = parseAuth(md);
      const actions = parseActions(md);
      totalActions += actions.length;
      summary.push({
        name,
        displayName,
        description,
        ...(tags && tags.length ? { tags } : {}),
        ...(auth ? { auth } : {}),
        actions,
      });
    }
  }

  await writeFile(OUT_PATH, JSON.stringify(summary, null, 0));
  const buf = Buffer.from(JSON.stringify(summary));
  console.log(`[build-catalog-summary] root=${CATALOG_ROOT}`);
  console.log(`[build-catalog-summary] scopes=${scopesUsed.length} (${scopesUsed.join(",")}) pieces=${summary.length} (skipped=${skipped}) actions=${totalActions}`);
  console.log(`[build-catalog-summary] wrote=${OUT_PATH} (${buf.length} bytes, ~${Math.ceil(buf.length / 4)} tokens)`);
  // muestra una muestra para verificación
  const sample = summary.find((p) => p.name === "@activepieces/piece-slack") ?? summary[0];
  console.log(`[build-catalog-summary] sample: ${sample?.name} auth=${sample?.auth} actions=${sample?.actions.length}`);
  console.log(`[build-catalog-summary]   first action: ${JSON.stringify(sample?.actions[0])}`);
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});