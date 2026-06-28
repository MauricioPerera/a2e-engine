// Piece source build (fase T2): dado un sourceDir + una lista de names,
// valida cada piece (validatePieceDir), bundlea SOLO las validas (build-piece.mjs)
// a un outRoot AISLADO, extrae su metadata y genera un catalogo OKF aislado a
// catalogOut. Las que fallan validacion (errors) o no se encuentran -> rejected.
//
// Doble modo de ejecucion del codigo de la piece:
//  - Sin T2_SANDBOX (pieces confiables): el bundle (esbuild) y la extraccion de
//    metadata (require del index.cjs + .metadata()) corren IN-PROCESS. Igual que
//    antes. Solo para pieces confiables.
//  - Con T2_SANDBOX=1 (repos T2 NO confiables): el bundle Y el require+.metadata()
//    corren DENTRO de un sandbox bwrap (scripts/sandbox-build.sh modo "process" ->
//    scripts/sandbox-process.mjs, red bloqueada, FS confinado). El sandbox escribe
//    <pkgDir>/metadata.json. El host SOLO lee ese JSON (datos): NUNCA hace require
//    del bundle no confiable. El catalogo OKF se genera desde ese metadata.json.
//    Esto cierra el vector abierto anterior (require+.metadata() in-process).
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { discoverSource } from "./discover.js";
import { validatePieceDir } from "../../piece-sdk/src/validate-from-dir.js";
import { generateOkfCatalog } from "../../okf-generator/src/okf-generator.js";
import { buildPiece } from "../../engine-adapter/build-piece.mjs";
import type {
  ActionOrTrigger,
  PieceAuthSummary,
  PieceMetadataInput,
  PieceProperty,
} from "../../okf-generator/src/types.js";

const require = createRequire(import.meta.url);

export interface BuildSelectedOpts {
  sourceDir: string;
  pieceNames: string[];
  outRoot: string;
  catalogOut: string;
  /** default true: valida antes de bundlear. false = saltar validacion. */
  validate?: boolean;
}

export interface BuiltPiece {
  name: string;
  dir: string;
  version: string;
}

export interface RejectedPiece {
  name: string;
  reason: string;
  findings?: { level: string; code: string; message: string }[];
}

export interface BuildSelectedResult {
  built: BuiltPiece[];
  rejected: RejectedPiece[];
  catalogPath: string;
}

// --- metadata extraction (espejo de load-one-piece.mjs, pero sobre el bundle) ---
// USADO SOLO en modo in-process (sin T2_SANDBOX, pieces confiables). Con
// T2_SANDBOX=1 la metadata se extrae DENTRO del sandbox (sandbox-process.mjs) y
// el host lee metadata.json.

function findPieceExport(mod: Record<string, unknown>): {
  metadata: () => Record<string, unknown>;
} | null {
  const d = (mod as { default?: Record<string, unknown> }).default;
  if (d && typeof (d as { metadata?: unknown }).metadata === "function") {
    return d as { metadata: () => Record<string, unknown> };
  }
  const dd = d?.default;
  if (dd && typeof (dd as { metadata?: unknown }).metadata === "function") {
    return dd as { metadata: () => Record<string, unknown> };
  }
  for (const k of Object.keys(mod)) {
    const v = mod[k] as Record<string, unknown>;
    if (v && typeof v.metadata === "function") {
      return v as { metadata: () => Record<string, unknown> };
    }
  }
  return null;
}

function serializeProps(props: unknown): Record<string, PieceProperty> {
  if (!props || typeof props !== "object") return {};
  const out: Record<string, PieceProperty> = {};
  for (const [k, p] of Object.entries(props as Record<string, unknown>)) {
    const pr = p as Record<string, unknown> | undefined;
    if (!pr) continue;
    out[k] = {
      type: (pr.type as string) ?? "UNKNOWN",
      displayName: (pr.displayName as string) ?? k,
      description: (pr.description as string) ?? "",
      required: !!pr.required,
      ...(pr.options !== undefined ? { options: pr.options } : {}),
    };
  }
  return out;
}

function serializeActions(obj: unknown): Record<string, ActionOrTrigger> {
  if (!obj || typeof obj !== "object") return {};
  const out: Record<string, ActionOrTrigger> = {};
  for (const [k, a] of Object.entries(obj as Record<string, unknown>)) {
    const ac = a as Record<string, unknown> | undefined;
    if (!ac) continue;
    out[k] = {
      name: (ac.name as string) ?? k,
      displayName: (ac.displayName as string) ?? k,
      description: (ac.description as string) ?? "",
      props: serializeProps(ac.props),
      ...(ac.requireAuth !== undefined ? { requireAuth: ac.requireAuth as boolean } : {}),
      ...(ac.strategy !== undefined ? { strategy: ac.strategy as string } : {}),
      ...(ac.audience !== undefined ? { audience: ac.audience as string } : {}),
      ...(ac.aiMetadata !== undefined
        ? {
            aiMetadata: {
              description: (ac.aiMetadata as Record<string, unknown>).description as string | undefined,
              idempotent: (ac.aiMetadata as Record<string, unknown>).idempotent as boolean | undefined,
            },
          }
        : {}),
    };
  }
  return out;
}

function normalizeAuth(auth: unknown): PieceAuthSummary | undefined {
  if (!auth) return undefined;
  const a = (Array.isArray(auth) ? auth[0] : auth) as Record<string, unknown> | undefined;
  if (!a || !a.type) return undefined;
  return {
    type: a.type as string,
    displayName: a.displayName as string | undefined,
    description: a.description as string | undefined,
    required: a.required as boolean | undefined,
  };
}

// Require el bundle ya generado por build-piece.mjs y extrae .metadata().
// EJECUTA codigo del piece in-process. SOLO modo sin T2_SANDBOX (pieces confiables).
// Con T2_SANDBOX=1 esta funcion NO se llama: la metadata viene de metadata.json
// escrito por sandbox-process.mjs dentro del sandbox.
function extractMetadataFromBundle(pkgDir: string): PieceMetadataInput {
  const indexCjs = path.join(pkgDir, "index.cjs");
  if (!existsSync(indexCjs)) throw new Error(`no index.cjs in bundle ${pkgDir}`);
  delete require.cache[indexCjs];
  const mod = require(indexCjs) as Record<string, unknown>;
  const piece = findPieceExport(mod);
  if (!piece) throw new Error("no createPiece export with .metadata()");
  const md = piece.metadata() as Record<string, unknown>;
  const pkg = JSON.parse(
    readFileSync(path.join(pkgDir, "package.json"), "utf8"),
  ) as { name: string; version: string };
  return {
    name: pkg.name,
    displayName: (md.displayName as string) ?? pkg.name,
    description: (md.description as string) ?? "",
    version: pkg.version,
    ...(md.logoUrl !== undefined ? { logoUrl: md.logoUrl as string } : {}),
    ...(md.categories !== undefined ? { categories: md.categories as string[] } : {}),
    ...(md.authors !== undefined ? { authors: md.authors as string[] } : {}),
    auth: normalizeAuth(md.auth),
    actions: serializeActions(md.actions),
    triggers: serializeActions(md.triggers),
  };
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Build una piece + extrae su metadata DENTRO de un sandbox bwrap (T2_SANDBOX=1):
// delega a scripts/sandbox-build.sh en modo "process", que corre sandbox-process.mjs
// (node + esbuild confinados, sin red, FS minimo). sandbox-process.mjs hace TANTO
// el bundle (esbuild) COMO el require+.metadata() del bundle no confiable, todo
// dentro del sandbox, y escribe <pkgDir>/metadata.json. El host SOLO lee ese JSON:
// NUNCA hace require del bundle. Devuelve { name, version, pkgDir, indexCjs } y la
// metadata leida del json (datos, no codigo).
export async function buildPieceSandboxed(
  pieceDir: string,
  outRoot: string,
): Promise<{ name: string; version: string; pkgDir: string; indexCjs: string; metadata: PieceMetadataInput }> {
  const pkg = JSON.parse(readFileSync(path.join(pieceDir, "package.json"), "utf8")) as {
    name: string; version: string;
  };
  const name = pkg.name;
  const version = pkg.version;
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(scriptDir, "..", "scripts", "sandbox-build.sh");
  let stdout = "";
  try {
    stdout = execFileSync(script, [pieceDir, outRoot, "process"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; stdout?: Buffer | string; message: string };
    const se = err.stderr ? (typeof err.stderr === "string" ? err.stderr : err.stderr.toString()) : "";
    const so = err.stdout ? (typeof err.stdout === "string" ? err.stdout : err.stdout.toString()) : "";
    throw new Error(
      `sandbox-build(process) failed for ${pieceDir}: ${se || so || err.message}`,
    );
  }
  const pkgDir = path.join(outRoot, "pieces", `${name}-${version}`, "node_modules", name);
  const indexCjs = path.join(pkgDir, "index.cjs");
  const metaPath = path.join(pkgDir, "metadata.json");
  if (!existsSync(indexCjs)) {
    throw new Error(
      `sandbox-build(process) produced no index.cjs at ${indexCjs}; stdout=${stdout.slice(-400)}`,
    );
  }
  if (!existsSync(metaPath)) {
    throw new Error(
      `sandbox-build(process) produced no metadata.json at ${metaPath}; stdout=${stdout.slice(-400)}`,
    );
  }
  // El host lee el JSON (datos). NO hace require del bundle.
  const metadata = JSON.parse(readFileSync(metaPath, "utf8")) as PieceMetadataInput;
  return { name, version, pkgDir, indexCjs, metadata };
}

export async function buildSelectedPieces(
  opts: BuildSelectedOpts,
): Promise<BuildSelectedResult> {
  const root = expandHome(opts.sourceDir);
  const doValidate = opts.validate !== false;
  const outRoot = path.resolve(opts.outRoot);
  const catalogOut = path.resolve(opts.catalogOut);
  mkdirSync(outRoot, { recursive: true });
  mkdirSync(catalogOut, { recursive: true });

  // Localiza dirs de pieces por name via discover (regex, SIN ejecutar codigo).
  const discovered = await discoverSource({ source: root });
  const dirMap = new Map<string, string>();
  for (const p of discovered.pieces) dirMap.set(p.name, path.join(root, p.dir));

  const built: BuiltPiece[] = [];
  const rejected: RejectedPiece[] = [];
  const valid: { name: string; absDir: string }[] = [];

  for (const name of opts.pieceNames) {
    const absDir = dirMap.get(name);
    if (!absDir || !existsSync(absDir)) {
      rejected.push({ name, reason: "not-found" });
      continue;
    }
    if (doValidate) {
      const vr = validatePieceDir(absDir);
      if (!vr.ok) {
        rejected.push({ name, reason: "validation-failed", findings: vr.findings });
        continue;
      }
    }
    valid.push({ name, absDir });
  }

  // T2_SANDBOX=1 -> bundle + extraccion de metadata DENTRO del sandbox bwrap
  // (sandbox-build.sh modo "process" -> sandbox-process.mjs). El host lee
  // metadata.json; NUNCA hace require del bundle no confiable.
  // Sin T2_SANDBOX -> build + extractMetadataFromBundle in-process (pieces confiables).
  const useSandbox = process.env.T2_SANDBOX === "1";
  const inputs: PieceMetadataInput[] = [];
  for (const { name, absDir } of valid) {
    try {
      let meta: PieceMetadataInput;
      let version: string;
      if (useSandbox) {
        const r = await buildPieceSandboxed(absDir, outRoot);
        meta = r.metadata;
        version = r.version;
      } else {
        const r = await buildPiece(absDir, outRoot);
        meta = extractMetadataFromBundle(r.pkgDir);
        version = r.version;
      }
      inputs.push(meta);
      built.push({
        name,
        dir: path.relative(root, absDir).replace(/\\/g, "/"),
        version,
      });
    } catch (e) {
      rejected.push({
        name,
        reason: "bundle-failed",
        findings: [{ level: "error", code: "bundle-error", message: (e as Error).message }],
      });
    }
  }

  // Genera + escribe el catalogo OKF aislado (solo las pieces bundleadas).
  const files = generateOkfCatalog(inputs);
  for (const f of files) {
    const dest = path.join(catalogOut, f.path);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, f.content);
  }

  return { built, rejected, catalogPath: catalogOut };
}