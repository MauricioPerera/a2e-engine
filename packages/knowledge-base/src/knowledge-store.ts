// knowledge-store.ts — PERSISTENCIA de la base de conocimiento (efectos: FS + git).
//
// Capa de efectos separada del núcleo puro knowledge-base.ts (determinista,
// certificable, sin reloj/FS/git). Aquí tocamos disco y shell: escribimos el doc
// OKF del entry con renderKnowledgeDoc, regeneramos el index.md leyendo los
// kb-*.md, y commiteamos en un repo git dedicado a la base de conocimiento.
//
// El reloj vive aquí: `now = new Date().toISOString()` (la capa de efectos es el
// único lugar donde se permite leer el reloj). freshness se recalcula con el
// now actual al listar/leer.
//
// Throughput: 1 commit por addEntry / attestEntry (MVP). Mismo patrón que
// run-store.ts (serialización por repo para que commits concurrentes no se pisen).
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  renderKnowledgeDoc,
  renderKnowledgeIndex,
  knowledgeFilePath,
  checkFreshness,
  type KnowledgeEntry,
  type Attestation,
  type FreshnessStatus,
} from "./knowledge-base.js";

const execFileP = promisify(execFile);

// Identidad git local para el repo de knowledge si no hay ninguna configurada
// (evita que `git commit` falle por falta de user.email/user.name). Se setea sólo
// local al repo, sin tocar la config global del usuario.
const GIT_IDENTITY = { name: "product-knowledge-store", email: "knowledge@product.local" };

// Cola de serialización por repo: dos addEntry/attestEntry concurrentes
// competirían por el index-lock de git y dejarían commits caídos. Serializamos
// por repoDir para que 1-commit-por-operación sea fiable también bajo concurrencia.
const repoLocks = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(key) ?? Promise.resolve();
  const p = (async () => {
    await prev;
    return fn();
  })();
  repoLocks.set(key, p.catch(() => {}));
  return p;
}

// Ejecuta `git -C repoDir <args>` y resuelve con {stdout, stderr}. Lanza si git
// sale con código != 0.
async function git(repoDir: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileP("git", ["-C", repoDir, ...args], { maxBuffer: 8 * 1024 * 1024 });
}

// Asegura que repoDir existe y es un repo git (git init -b main si no lo es) y
// que hay identidad para commitear (setea local sólo si falta).
async function ensureGitRepo(repoDir: string): Promise<void> {
  await fs.mkdir(repoDir, { recursive: true });
  try {
    await fs.access(path.join(repoDir, ".git"));
  } catch {
    await execFileP("git", ["-C", repoDir, "init", "-b", "main"], { maxBuffer: 8 * 1024 * 1024 });
  }
  try {
    await git(repoDir, ["config", "--get", "user.email"]);
  } catch {
    await git(repoDir, ["config", "user.name", GIT_IDENTITY.name]);
    await git(repoDir, ["config", "user.email", GIT_IDENTITY.email]);
  }
}

// --- Parser de frontmatter propio de knowledge (soporta el bloque anidado
// `attestation:` que el parser plano de run-store no entiende). Reconstruye sólo
// los campos que un KnowledgeEntry necesita. ---
function parseKnowledgeFrontmatter(content: string): Record<string, unknown> {
  const lines = content.split("\n");
  if (lines[0] !== "---") return {};
  const out: Record<string, unknown> = {};
  let i = 1;
  while (i < lines.length && lines[i] !== "---") {
    const line = lines[i];
    if (line.startsWith("  ")) {
      // línea anidada suelta fuera de un bloque reconocido: la ignoramos.
      i++;
      continue;
    }
    const idx = line.indexOf(":");
    if (idx < 0) {
      i++;
      continue;
    }
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k === "attestation") {
      const att: Record<string, string> = {};
      i++;
      while (i < lines.length && lines[i] !== "---" && lines[i].startsWith("  ")) {
        const l = lines[i];
        const li = l.indexOf(":");
        if (li >= 0) att[l.slice(0, li).trim()] = l.slice(li + 1).trim();
        i++;
      }
      out.attestation = att;
      continue;
    }
    if (k === "tags") {
      const inner = v.replace(/^\[/, "").replace(/\]$/, "").trim();
      out.tags = inner ? inner.split(",").map((s) => s.trim()).filter(Boolean) : [];
    } else {
      out[k] = v;
    }
    i++;
  }
  return out;
}

// Devuelve el cuerpo markdown (después del cierre del frontmatter).
function splitBody(content: string): string {
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) return "";
  return content.slice(end + 5);
}

// Extrae el texto de una sección `## <header>` hasta la siguiente `## <end>`.
function extractSection(body: string, header: string, end: string): string {
  const start = body.indexOf(`## ${header}\n`);
  if (start < 0) return "";
  const contentStart = start + `## ${header}\n`.length;
  const endIdx = body.indexOf(`## ${end}`, contentStart);
  const section = endIdx < 0 ? body.slice(contentStart) : body.slice(contentStart, endIdx);
  return section.replace(/^\n+/, "").replace(/\n+$/, "").trim();
}

// Reconstruye un KnowledgeEntry desde el contenido de un kb-*.md.
function entryFromContent(content: string): KnowledgeEntry | null {
  const fm = parseKnowledgeFrontmatter(content);
  if (fm.type !== "knowledge" || typeof fm.id !== "string") return null;
  const body = splitBody(content);
  const problem = extractSection(body, "Problem", "Resolution");
  const resolution = extractSection(body, "Resolution", "Vigencia");
  const entry: KnowledgeEntry = {
    id: String(fm.id),
    title: typeof fm.title === "string" ? fm.title : "",
    tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
    createdAt: typeof fm.createdAt === "string" ? fm.createdAt : "",
    updatedAt: typeof fm.updatedAt === "string" ? fm.updatedAt : "",
    ttlDays: typeof fm.ttlDays === "string" ? Number(fm.ttlDays) : 30,
    problem,
    resolution,
  };
  if (typeof fm.sourceRunId === "string" && fm.sourceRunId) entry.sourceRunId = fm.sourceRunId;
  const att = fm.attestation as Record<string, string> | undefined;
  if (att && typeof att === "object") {
    const a: Attestation = {
      by: att.by ?? "",
      at: att.at ?? "",
      sha256: att.sha256 ?? "",
      expiresAt: att.expiresAt ?? "",
    };
    entry.attestation = a;
  }
  return entry;
}

// Lee todos los kb-*.md del repo y los reconstruye a KnowledgeEntry (ordenados
// por updatedAt desc para que el índice muestre los más recientes primero).
async function readAllEntries(repoDir: string): Promise<KnowledgeEntry[]> {
  const dir = path.join(repoDir, "knowledge");
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const entries: KnowledgeEntry[] = [];
  for (const name of names) {
    if (!/^kb-.*\.md$/.test(name)) continue;
    let content: string;
    try {
      content = await fs.readFile(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    const e = entryFromContent(content);
    if (e) entries.push(e);
  }
  entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return entries;
}

// Regenera el index.md a partir de los kb-*.md existentes en el repo.
async function regenerateKnowledgeIndex(repoDir: string): Promise<void> {
  const entries = await readAllEntries(repoDir);
  const now = new Date().toISOString();
  const indexContent = renderKnowledgeIndex(entries, now);
  const dir = path.join(repoDir, "knowledge");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.md"), indexContent);
}

// Escribe el doc OKF de un entry, regenera el index.md y commitea. Serializado
// por repo. Devuelve la ruta absoluta del .md escrito.
export async function addEntry(
  entry: KnowledgeEntry,
  opts: { repoDir: string },
): Promise<{ path: string }> {
  const { repoDir } = opts;
  const { dir, file } = knowledgeFilePath(entry);
  const absDir = path.join(repoDir, dir);
  const absFile = path.join(absDir, file);
  await serialized(repoDir, async () => {
    await ensureGitRepo(repoDir);
    await fs.mkdir(absDir, { recursive: true });
    const now = new Date().toISOString();
    await fs.writeFile(absFile, renderKnowledgeDoc(entry, now));
    await regenerateKnowledgeIndex(repoDir);
    await git(repoDir, ["add", "-A"]);
    try {
      await git(repoDir, ["commit", "-m", `knowledge ${entry.id} ${entry.title}`]);
    } catch (e) {
      console.error(
        `[knowledge-store] commit failed for ${entry.id}: ${(e as Error)?.message ?? e}`,
      );
    }
  });
  return { path: absFile };
}

// Lista los entries del repo con su freshness recalculada al now actual.
export async function listEntries(
  opts: { repoDir: string },
): Promise<Array<KnowledgeEntry & { freshness: FreshnessStatus }>> {
  const entries = await readAllEntries(opts.repoDir);
  const now = new Date().toISOString();
  return entries.map((entry) => ({ ...entry, freshness: checkFreshness(entry, now) }));
}

// Lee el doc OKF + record de un entry, o null si no existe.
export async function getEntry(
  opts: { repoDir: string; id: string },
): Promise<{ markdown: string; record: KnowledgeEntry & { freshness: FreshnessStatus } } | null> {
  const file = path.join(opts.repoDir, "knowledge", `kb-${opts.id}.md`);
  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  const record = entryFromContent(content);
  if (!record) return null;
  const now = new Date().toISOString();
  return { markdown: content, record: { ...record, freshness: checkFreshness(record, now) } };
}

// Atesta un entry (vigencia humana): carga el entry, calcula sha256 del
// contenido (problem+resolution), setea attestation {by, at, sha256, expiresAt},
// re-renderiza y commitea "attest <id> by <by>". Devuelve {ok:false} si el entry
// no existe.
export async function attestEntry(
  opts: { repoDir: string; id: string; by: string; expiresAt: string },
): Promise<{ ok: boolean }> {
  const { repoDir, id, by, expiresAt } = opts;
  const file = path.join(repoDir, "knowledge", `kb-${id}.md`);
  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch {
    return { ok: false };
  }
  const entry = entryFromContent(content);
  if (!entry) return { ok: false };
  const sha256 = createHash("sha256")
    .update(entry.problem)
    .update(entry.resolution)
    .digest("hex");
  const now = new Date().toISOString();
  entry.attestation = { by, at: now, sha256, expiresAt };
  await serialized(repoDir, async () => {
    await ensureGitRepo(repoDir);
    await fs.writeFile(file, renderKnowledgeDoc(entry, now));
    await regenerateKnowledgeIndex(repoDir);
    await git(repoDir, ["add", "-A"]);
    try {
      await git(repoDir, ["commit", "-m", `attest ${id} by ${by}`]);
    } catch (e) {
      console.error(
        `[knowledge-store] attest commit failed for ${id}: ${(e as Error)?.message ?? e}`,
      );
    }
  });
  return { ok: true };
}

// Devuelve el index.md crudo del repo, o null si aún no hay entries.
export async function getKnowledgeIndexMarkdown(
  opts: { repoDir: string },
): Promise<string | null> {
  const file = path.join(opts.repoDir, "knowledge", "index.md");
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    // Sin index.md: si hay entries, regenera y lee; si no, null.
    const entries = await readAllEntries(opts.repoDir);
    if (entries.length === 0) return null;
    await regenerateKnowledgeIndex(opts.repoDir);
    try {
      return await fs.readFile(file, "utf8");
    } catch {
      return null;
    }
  }
}