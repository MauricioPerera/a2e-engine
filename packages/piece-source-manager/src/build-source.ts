// Piece source build (fase T2): dado un sourceDir + una lista de names,
// valida cada piece (validatePieceDir), bundlea SOLO las validas (build-piece.mjs)
// a un outRoot AISLADO, extrae su metadata y genera un catalogo OKF aislado a
// catalogOut. Las que fallan validacion (errors) o no se encuentran -> rejected.
//
// CAVEAT (documentado): la extraccion de metadata EJECUTA el codigo del bundle
// in-process (require del index.cjs + .metadata()), y el bundle (esbuild) corre
// en el mismo proceso. Para repos T2 NO confiables esto deberia ir SANDBOXEADO
// (contenedor sin red, limites). El MVP lo hace in-process; el sandbox de build
// es endurecimiento posterior.
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
// EJECUTA codigo del piece in-process (ver CAVEAT arriba).
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

  // Bundlea cada piece valida al outRoot aislado y extrae su metadata.
  const inputs: PieceMetadataInput[] = [];
  for (const { name, absDir } of valid) {
    try {
      const r = await buildPiece(absDir, outRoot);
      const meta = extractMetadataFromBundle(r.pkgDir);
      inputs.push(meta);
      built.push({
        name,
        dir: path.relative(root, absDir).replace(/\\/g, "/"),
        version: r.version,
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