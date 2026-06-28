// run-store.ts — PERSISTENCIA de runs (efectos: FS + git).
//
// Capa de efectos separada del núcleo puro run-logger.ts (que es determinista y
// certificable). Este módulo toca disco y shell: escribe el OKF del run con
// renderRunDoc, regenera el index.md del día con renderDayIndex, y commitea en
// un repo git dedicado al run-history (legible por agente y por humano).
//
// Throughput: 1 commit por run (MVP). A alto volumen esto es insostenible
// (I/O + git index por run); cuando crezca, conviene batch: acumular runs en
// memoria y flush+commit cada N segundos o M runs en un solo commit por batch.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  renderRunDoc,
  renderDayIndex,
  runFilePath,
  type FlowRun,
  type StepRecord,
} from "./run-logger.js";

const execFileP = promisify(execFile);

// Identidad git local para el repo de runs si no hay ninguna configurada (evita
// que `git commit` falle por falta de user.email/user.name). Se setea sólo local
// al repo de runs, sin tocar la config global del usuario.
const GIT_IDENTITY = { name: "product-run-store", email: "runs@product.local" };

// Cola de serialización por repo: las escrituras git concurrentes (ej. loop
// de poll disparando varios items a la vez) competirían por el index-lock de
// git y dejarían commits caídos. Serializamos appendRun por repoDir para que
// 1-commit-por-run sea fiable también bajo concurrencia (MVP; a alto volumen
// conviene batch + un solo commit por flush).
const repoLocks = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(key) ?? Promise.resolve();
  const p = (async () => {
    await prev;
    return fn();
  })();
  // La cadena almacenada nunca rechaza (catch) para no envenenar a los
  // siguientes callers si una appendRun fallara.
  repoLocks.set(key, p.catch(() => {}));
  return p;
}

// Ejecuta `git -C repoDir <args>` y resuelve con {stdout, stderr}. Lanza si git
// sale con código != 0 (el caller decide si es fatal o best-effort).
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
  // user.email: si no hay heredado (global) ni local, setea local.
  try {
    await git(repoDir, ["config", "--get", "user.email"]);
  } catch {
    await git(repoDir, ["config", "user.name", GIT_IDENTITY.name]);
    await git(repoDir, ["config", "user.email", GIT_IDENTITY.email]);
  }
}

// Parsea el frontmatter YAML plano que produce renderFrontmatter (clave: valor
// por línea, valores opcionalmente quoted). Sólo extrae los campos que el índice
// del día necesita; no es un parser YAML general.
export function parseFrontmatter(content: string): Record<string, string> {
  const lines = content.split("\n");
  if (lines[0] !== "---") return {};
  const out: Record<string, string> = {};
  for (let i = 1; i < lines.length && lines[i] !== "---"; i++) {
    const idx = lines[i].indexOf(":");
    if (idx < 0) continue;
    const k = lines[i].slice(0, idx).trim();
    let v = lines[i].slice(idx + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) {
      v = v
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    out[k] = v;
  }
  return out;
}

// Lee los run-*.md de un directorio de día y devuelve FlowRun mínimos (sólo los
// campos que renderDayIndex/renderIndexRow leen: runId, status, durationMs,
// failedStep, + startedAt para ordenar). Los steps quedan vacíos: el índice no
// los necesita y así evitamos re-parsear el cuerpo.
async function readDayRuns(dir: string): Promise<FlowRun[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const runs: FlowRun[] = [];
  for (const name of entries) {
    if (!/^run-.*\.md$/.test(name)) continue;
    let content: string;
    try {
      content = await fs.readFile(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(content);
    const run: FlowRun = {
      runId: fm.runId ?? name.replace(/^run-/, "").replace(/\.md$/, ""),
      source: fm.source ?? "",
      status: fm.status ?? "UNKNOWN",
      startedAt: fm.startedAt ?? "",
      finishedAt: fm.finishedAt ?? "",
      durationMs: Number(fm.durationMs ?? 0),
      steps: [],
    };
    if (fm.failedStep && fm.failedStep !== "null") run.failedStep = fm.failedStep;
    runs.push(run);
  }
  runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return runs;
}

// Regenera el index.md del día a partir de los run-*.md existentes en la carpeta
// (índice incremental: cada appendRun reescribe el index con todos los runs del
// día conocidos en disco, así no necesitamos mantener estado en memoria).
async function regenerateDayIndex(repoDir: string, date: string): Promise<void> {
  const dir = path.join(repoDir, "runs", date);
  const runs = await readDayRuns(dir);
  const indexContent = renderDayIndex(date, runs);
  await fs.writeFile(path.join(dir, "index.md"), indexContent);
}

// Construye un FlowRun a partir del resultado del engine (verdict + steps) y los
// timestamps medidos por el caller. Centraliza el mapeo executeFlow->FlowRun
// para que /execute, webhooks y poll lo compartan sin duplicar lógica.
export function flowRunFromResult(args: {
  runId: string;
  source: string;
  startedAt: string;
  finishedAt: string;
  verdict: { status: string; failedStep?: string | { name?: string; displayName?: string; message?: string } };
  steps: Record<string, { status: string; output: unknown; errorMessage?: string }>;
  error?: { name?: string; message?: string; stack?: string };
}): FlowRun {
  // Normalizamos a string los campos que alimentan renderRunDoc: el engine
  // puede devolver status/failedStep/errorMessage no-string (ej. verdict
  // FAILED de piece-not-found), y escapeYaml (puro, certificado) asume strings.
  const steps: StepRecord[] = Object.entries(args.steps ?? {}).map(([name, s]) => {
    const step: StepRecord = { name, status: String(s?.status ?? "UNKNOWN") };
    if (s?.output !== undefined) step.output = s.output;
    if (s?.errorMessage) step.error = { message: String(s.errorMessage) };
    return step;
  });
  const durationMs =
    new Date(args.finishedAt).getTime() - new Date(args.startedAt).getTime();
  const run: FlowRun = {
    runId: args.runId,
    source: args.source,
    status: String(args.verdict?.status ?? "UNKNOWN"),
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    steps,
  };
  const fs = args.verdict?.failedStep;
  const failedStepName =
    typeof fs === "string" ? fs : fs && typeof fs === "object" ? String(fs.name ?? "") : "";
  if (failedStepName) run.failedStep = failedStepName;
  if (args.error) {
    run.error = {
      ...(args.error.name != null ? { name: String(args.error.name) } : {}),
      ...(args.error.message != null ? { message: String(args.error.message) } : {}),
      ...(args.error.stack != null ? { stack: String(args.error.stack) } : {}),
    };
  } else if (run.status !== "SUCCEEDED") {
    // Sin excepción explícita: derivar el error del step fallido (preferir
    // verdict.failedStep) para que el frontmatter lleve `error:` también
    // cuando executeFlow devolvió verdict FAILED sin lanzar.
    const fsMessage = fs && typeof fs === "object" ? fs.message : undefined;
    const failedName =
      failedStepName ||
      Object.entries(args.steps ?? {}).find(([, s]) => s?.status === "FAILED")?.[0];
    const failedStep = failedName ? (args.steps ?? {})[failedName] : undefined;
    const msg = fsMessage ?? failedStep?.errorMessage;
    if (msg) run.error = { message: String(msg) };
  }
  return run;
}

// Escribe el OKF del run, regenera el index del día y commitea en repoDir.
// Best-effort: si el commit (o cualquier paso) falla, lo loguea y NO lanza —
// el caller (product-api) nunca debe romper su respuesta por el run-history.
// Devuelve la ruta absoluta del .md escrito (o la pretendida si falló antes).
export async function appendRun(
  run: FlowRun,
  opts: { repoDir: string },
): Promise<{ path: string }> {
  const { repoDir } = opts;
  const { dir, file } = runFilePath(run);
  const absDir = path.join(repoDir, dir);
  const absFile = path.join(absDir, file);
  // Serializado por repo: evita commits concurrentes que se pisan entre sí.
  await serialized(repoDir, async () => {
    try {
      await ensureGitRepo(repoDir);
    await fs.mkdir(absDir, { recursive: true });
    await fs.writeFile(absFile, renderRunDoc(run));
    const date = run.startedAt.slice(0, 10);
    await regenerateDayIndex(repoDir, date);
    // 1 commit por run (MVP). Ver nota de batch al inicio del archivo.
    await git(repoDir, ["add", "-A"]);
    try {
      await git(repoDir, ["commit", "-m", `run ${run.runId} ${run.status}`]);
    } catch (e) {
      // Nada que commitear, o problema transitorio de git: no romper al caller.
      console.error(
        `[run-store] commit failed for ${run.runId}: ${(e as Error)?.message ?? e}`,
      );
    }
    } catch (e) {
      console.error(
        `[run-store] appendRun failed for ${run.runId}: ${(e as Error)?.message ?? e}`,
      );
    }
  });
  return { path: absFile };
}

// Lista fechas y runs recientes. Con `date`, lista los runs de ese día. Sin
// `date`, devuelve todas las fechas disponibles + los runs más recientes (cap
// 20) recorriendo fechas de la más nueva a la más vieja.
export async function listRuns(opts: {
  repoDir: string;
  date?: string;
}): Promise<{
  dates: string[];
  runs: Array<{ date: string; runId: string; status: string; durationMs: number; failedStep?: string }>;
}> {
  const { repoDir, date } = opts;
  const runsRoot = path.join(repoDir, "runs");
  let dateDirs: string[] = [];
  try {
    dateDirs = (await fs.readdir(runsRoot)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  } catch {
    return { dates: [], runs: [] };
  }
  dateDirs.sort().reverse();

  const toRow = (r: FlowRun, date: string) => {
    const row: { date: string; runId: string; status: string; durationMs: number; failedStep?: string } = {
      date,
      runId: r.runId,
      status: r.status,
      durationMs: r.durationMs,
    };
    if (r.failedStep) row.failedStep = r.failedStep;
    return row;
  };

  if (date) {
    const runs = (await readDayRuns(path.join(runsRoot, date))).map((r) => toRow(r, date));
    return { dates: dateDirs, runs };
  }

  const recent: ReturnType<typeof toRow>[] = [];
  for (const d of dateDirs) {
    const rs = await readDayRuns(path.join(runsRoot, d));
    // readDayRuns ordena asc por startedAt; invertimos para tener recientes primero.
    for (const r of rs.slice().reverse()) recent.push(toRow(r, d));
    if (recent.length >= 20) break;
  }
  return { dates: dateDirs, runs: recent.slice(0, 20) };
}

// Lee el .md de un run concreto, o null si no existe.
export async function getRun(opts: {
  repoDir: string;
  date: string;
  runId: string;
}): Promise<string | null> {
  const file = path.join(opts.repoDir, "runs", opts.date, `run-${opts.runId}.md`);
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}