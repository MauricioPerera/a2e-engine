// workflow-store.ts — PERSISTENCIA de workflows (efectos: FS + git).
//
// Capa de efectos separada del núcleo puro workflow-registry.ts (que es
// determinista y certificable). Este módulo toca disco y shell: escribe el OKF
// del workflow con renderWorkflowDoc, regenera el index.md del registro con
// renderWorkflowIndex, y commitea en un repo git dedicado (legible por agente y
// por humano). Replica el enfoque de run-store.ts (mismo patrón de
// ensureGitRepo + cola de serialización por repo + 1 commit por escritura).
//
// Throughput: 1 commit por saveWorkflow (MVP). A alto volumen conviene batch
// (ver nota equivalente en run-store.ts).
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  renderWorkflowDoc,
  renderWorkflowIndex,
  workflowFilePath,
  type WorkflowRecord,
  type WorkflowStep,
} from "./workflow-registry.js";

const execFileP = promisify(execFile);

// Identidad git local para el repo de workflows si no hay ninguna configurada
// (evita que `git commit` falle por falta de user.email/user.name). Sólo local
// al repo, sin tocar la config global del usuario.
const GIT_IDENTITY = { name: "product-workflow-store", email: "workflows@product.local" };

// Cola de serialización por repo: escrituras git concurrentes competirían por
// el index-lock de git y dejarían commits caídos. Serializamos saveWorkflow por
// repoDir para que 1-commit-por-save sea fiable también bajo concurrencia.
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

// Parsea el frontmatter YAML plano que produce renderWorkflowDoc (clave: valor
// por línea, valores opcionalmente quoted; piecesUsed es una lista YAML de
// `  - "piece"`). Extrae los campos del workflow + la lista piecesUsed. No es un
// parser YAML general.
export function parseFrontmatter(content: string): {
  scalars: Record<string, string>;
  piecesUsed: string[];
} {
  const lines = content.split("\n");
  if (lines[0] !== "---") return { scalars: {}, piecesUsed: [] };
  const scalars: Record<string, string> = {};
  const piecesUsed: string[] = [];
  let i = 1;
  for (; i < lines.length && lines[i] !== "---"; i++) {
    const line = lines[i];
    // Lista piecesUsed: líneas `  - "value"` (indentadas, sin clave `:`).
    const listMatch = line.match(/^\s+-\s+(.*)$/);
    if (listMatch && Object.prototype.hasOwnProperty.call(scalars, "piecesUsed")) {
      let v = listMatch[1].trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      if (v.length > 0) piecesUsed.push(v);
      continue;
    }
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) {
      v = v
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    scalars[k] = v;
  }
  return { scalars, piecesUsed };
}

// Extrae el bloque ```json``` de la Definition del doc y lo parsea como
// WorkflowStep[]. Devuelve [] si no se encuentra o no parsea.
function parseSteps(content: string): WorkflowStep[] {
  const startIdx = content.indexOf("```json");
  if (startIdx < 0) return [];
  const afterFence = startIdx + "```json".length;
  const endIdx = content.indexOf("```", afterFence);
  if (endIdx < 0) return [];
  const block = content.slice(afterFence, endIdx).trim();
  if (!block) return [];
  try {
    const parsed = JSON.parse(block);
    return Array.isArray(parsed) ? (parsed as WorkflowStep[]) : [];
  } catch {
    return [];
  }
}

// Lee un workflow del repo por id, o null si no existe. Devuelve el markdown
// crudo y el record reconstruido (incluye steps[] parseados del bloque JSON para
// poder re-ejecutar).
async function readWorkflowFile(
  repoDir: string,
  id: string,
): Promise<{ markdown: string; record: WorkflowRecord } | null> {
  const file = path.join(repoDir, "workflows", `wf-${id}.md`);
  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  const { scalars, piecesUsed } = parseFrontmatter(content);
  void piecesUsed; // piecesUsed ya está en el frontmatter; steps[] se parsea del JSON.
  const steps = parseSteps(content);
  const record: WorkflowRecord = {
    id: scalars.id ?? id,
    name: scalars.name ?? "",
    createdAt: scalars.createdAt ?? "",
    updatedAt: scalars.updatedAt ?? "",
    steps,
  };
  if (scalars.description !== undefined) record.description = scalars.description;
  if (scalars.version !== undefined) record.version = scalars.version;
  return { markdown: content, record };
}

// Lee todos los wf-*.md del repo y devuelve WorkflowRecord[] (con steps para
// que renderWorkflowIndex pueda recomputar piecesUsed). Ordenado por nombre
// para un index estable.
async function readAllWorkflows(repoDir: string): Promise<WorkflowRecord[]> {
  const dir = path.join(repoDir, "workflows");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const records: WorkflowRecord[] = [];
  for (const name of entries) {
    if (!/^wf-.*\.md$/.test(name)) continue;
    const id = name.replace(/^wf-/, "").replace(/\.md$/, "");
    const got = await readWorkflowFile(repoDir, id);
    if (got) records.push(got.record);
  }
  records.sort((a, b) => a.name.localeCompare(b.name));
  return records;
}

// Regenera el index.md del registro a partir de los wf-*.md existentes (índice
// incremental: cada saveWorkflow reescribe el index con todos los workflows
// conocidos en disco, sin estado en memoria).
async function regenerateIndex(repoDir: string): Promise<void> {
  const workflows = await readAllWorkflows(repoDir);
  const indexContent = renderWorkflowIndex(workflows);
  await fs.writeFile(path.join(repoDir, "index.md"), indexContent);
}

// Guarda un workflow: versiona si ya existe (v1->v2...), preserva createdAt del
// original, actualiza updatedAt, escribe el OKF, regenera index.md y commitea.
// Devuelve { path, version }. Lanza si git falla de forma fatal (el caller
// decide si es best-effort).
export async function saveWorkflow(
  wf: WorkflowRecord,
  opts: { repoDir: string },
): Promise<{ path: string; version: string }> {
  const { repoDir } = opts;
  const { dir, file } = workflowFilePath(wf);
  const absDir = path.join(repoDir, dir);
  const absFile = path.join(absDir, file);
  let version = "v1";
  await serialized(repoDir, async () => {
    await ensureGitRepo(repoDir);
    await fs.mkdir(absDir, { recursive: true });
    // Versionado: si ya existe el doc, incrementa versión y preserva createdAt.
    const existing = await readWorkflowFile(repoDir, wf.id);
    if (existing) {
      const curRaw = existing.record.version ?? "v1";
      const curNum = parseInt(curRaw.replace(/^v/i, ""), 10);
      const next = (Number.isFinite(curNum) && curNum > 0 ? curNum : 1) + 1;
      version = `v${next}`;
      wf.version = version;
      if (existing.record.createdAt) wf.createdAt = existing.record.createdAt;
    } else {
      wf.version = version;
    }
    wf.updatedAt = new Date().toISOString();
    await fs.writeFile(absFile, renderWorkflowDoc(wf));
    await regenerateIndex(repoDir);
    await git(repoDir, ["add", "-A"]);
    try {
      await git(repoDir, ["commit", "-m", `workflow ${wf.id} ${version} ${wf.name}`]);
    } catch (e) {
      // Nada que commitear (sin cambios) o problema transitorio: no romper.
      console.error(
        `[workflow-store] commit failed for ${wf.id}: ${(e as Error)?.message ?? e}`,
      );
    }
  });
  return { path: absFile, version };
}

// Lista los workflows del repo (sólo frontmatter: id/name/piecesUsed/stepCount/
// updatedAt). Ordenado por nombre.
export async function listWorkflows(
  opts: { repoDir: string },
): Promise<
  Array<{ id: string; name: string; piecesUsed: string[]; stepCount: number; updatedAt: string; version?: string }>
> {
  const { repoDir } = opts;
  const dir = path.join(repoDir, "workflows");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const rows: Array<{
    id: string;
    name: string;
    piecesUsed: string[];
    stepCount: number;
    updatedAt: string;
    version?: string;
  }> = [];
  for (const name of entries) {
    if (!/^wf-.*\.md$/.test(name)) continue;
    const id = name.replace(/^wf-/, "").replace(/\.md$/, "");
    let content: string;
    try {
      content = await fs.readFile(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    const { scalars, piecesUsed } = parseFrontmatter(content);
    const row = {
      id,
      name: scalars.name ?? "",
      piecesUsed,
      stepCount: Number(scalars.stepCount ?? 0),
      updatedAt: scalars.updatedAt ?? "",
    };
    if (scalars.version !== undefined) (row as { version?: string }).version = scalars.version;
    rows.push(row);
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

// Lee el index.md crudo del registro (OKF), o null si no existe.
export async function getIndexMarkdown(
  opts: { repoDir: string },
): Promise<string | null> {
  try {
    return await fs.readFile(path.join(opts.repoDir, "index.md"), "utf8");
  } catch {
    return null;
  }
}

// Devuelve el doc OKF (markdown) + el record (con steps[] para re-ejecutar), o
// null si el workflow no existe.
export async function getWorkflow(
  opts: { repoDir: string; id: string },
): Promise<{ markdown: string; record: WorkflowRecord } | null> {
  return readWorkflowFile(opts.repoDir, opts.id);
}