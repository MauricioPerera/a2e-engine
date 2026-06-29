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
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { discoverSource } from "./discover.js";
import { validatePieceDir } from "../../piece-sdk/src/validate-from-dir.js";
import type { CapabilityManifest } from "../../piece-sdk/src/piece-sdk.ts";
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
  // Findings (warns) de la validacion que PASO (ok:true). Las que no bloquean
  // (ej. executes-code declarado, no-manifest/egress) viajan en la respuesta para
  // que el operador VEA al importar las capacidades declaradas de la piece.
  // Vacio/ausente si la piece valido sin warns o si validate=false.
  findings?: { level: string; code: string; message: string }[];
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

// Instala las deps de TERCEROS de una piece (las que NO son @activepieces/*,
// que se resuelven por alias de esbuild) en pieceDir/node_modules, ANTES del
// bundle. Sin esto, esbuild no resuelve imports como `jsonata` en pieces de
// repos no confiables (su node_modules no viene en el source importado).
//
// `--ignore-scripts` es OBLIGATORIO: los paquetes son no confiables y un
// postinstall podria RCEar el host. El codigo de la piece solo correra luego
// DENTRO del sandbox (T2_SANDBOX=1); el install solo baja codigo, no lo ejecuta.
//
// npm se ejecuta con cwd=pieceDir, pero ANTES se intercambia package.json por
// un stub que contiene SOLO las deps de terceros: npm en modo workspace:* no
// soporta el spec `workspace:` (EUNSUPPORTEDPROTOCOL) de las @activepieces/*.
// Las @activepieces/* no se instalan (las resuelve el alias de esbuild desde
// AP_REPO); instalarlas desde el registry fallaria anyway. El package.json
// original se restaura siempre (finally). El stub es reverible: si el proceso
// muere a medias, el package.json del source importado (copia en /tmp) queda
// stubbed, lo cual es inocuo para un repo no confiable de importacion.
//
// Si el install falla, lanza -> la piece se rechaza con code "deps-install-failed"
// (el batch continua; no crashea).
function installThirdPartyDeps(pieceDir: string): void {
  const pkgPath = path.join(pieceDir, "package.json");
  if (!existsSync(pkgPath)) return; // sin package.json -> nada que instalar
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const deps = pkg.dependencies ?? {};
  const thirdParty: Record<string, string> = {};
  for (const [k, v] of Object.entries(deps)) {
    // @activepieces/* van por alias de esbuild (AP_REPO); no se instalan.
    if (k.startsWith("@activepieces/")) continue;
    if (typeof v === "string" && v.length > 0) thirdParty[k] = v;
  }
  if (Object.keys(thirdParty).length === 0) return; // sin deps de terceros

  const backup = readFileSync(pkgPath);
  const lockPath = path.join(pieceDir, "package-lock.json");
  let lockBackup: Buffer | null = null;
  const hadLock = existsSync(lockPath);
  if (hadLock) {
    lockBackup = readFileSync(lockPath);
    // Un lock preexistente (con specs workspace:*) chocaria con el stub; se
    // restaura en finally.
    unlinkSync(lockPath);
  }
  const stub = { ...pkg, dependencies: thirdParty, devDependencies: {}, peerDependencies: {} };
  try {
    writeFileSync(pkgPath, JSON.stringify(stub, null, 2));
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save"], {
      cwd: pieceDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; stdout?: Buffer | string; message: string };
    const se = err.stderr ? (typeof err.stderr === "string" ? err.stderr : err.stderr.toString()) : "";
    const so = err.stdout ? (typeof err.stdout === "string" ? err.stdout : err.stdout.toString()) : "";
    throw new Error(
      `npm install (third-party deps) failed for ${pieceDir}: ${(se || so || err.message).slice(-600)}`,
    );
  } finally {
    writeFileSync(pkgPath, backup);
    if (hadLock && lockBackup) writeFileSync(lockPath, lockBackup);
  }
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

// Lee <pieceDir>/piece-manifest.json y lo mapea al CapabilityManifest que espera
// validatePiece. Si el archivo no existe o no parsea, devuelve undefined (la
// validacion tratara a la piece como "no declarada": executesCode -> error, como
// antes). El JSON on-disk ya usa el shape del SDK (network.egress, executesCode,
// readsEnv, readsFiles, auth); se construye el manifest de forma defensiva
// descartando campos de tipo incorrecto para no ensuciar la validacion.
function readCapabilityManifest(pieceDir: string): CapabilityManifest | undefined {
  const manifestPath = path.join(pieceDir, "piece-manifest.json");
  if (!existsSync(manifestPath)) return undefined;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const manifest: CapabilityManifest = {};
  if (typeof json.executesCode === "boolean") manifest.executesCode = json.executesCode;
  if (typeof json.readsEnv === "boolean") manifest.readsEnv = json.readsEnv;
  if (typeof json.readsFiles === "boolean") manifest.readsFiles = json.readsFiles;
  const auth = json.auth;
  if (
    auth === "OAUTH2" || auth === "SECRET_TEXT" || auth === "CUSTOM_AUTH" ||
    auth === "BASIC_AUTH" || auth === "NONE"
  ) {
    manifest.auth = auth;
  }
  const net = json.network as { egress?: unknown } | undefined;
  if (net && Array.isArray(net.egress)) {
    const egress = net.egress.filter((h): h is string => typeof h === "string");
    if (egress.length > 0) manifest.network = { egress };
  }
  return Object.keys(manifest).length > 0 ? manifest : undefined;
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
  // findings de la validacion que PASO (ok:true) por name, para propagarlos al
  // objeto built de cada piece (warns no bloqueantes: executes-code declarado,
  // egress, etc.). Solo se guardan si doValidate corrio.
  const valid: { name: string; absDir: string; findings?: { level: string; code: string; message: string }[] }[] = [];

  for (const name of opts.pieceNames) {
    const absDir = dirMap.get(name);
    if (!absDir || !existsSync(absDir)) {
      rejected.push({ name, reason: "not-found" });
      continue;
    }
    if (doValidate) {
      const manifest = readCapabilityManifest(absDir);
      const vr = validatePieceDir(absDir, manifest);
      if (!vr.ok) {
        rejected.push({ name, reason: "validation-failed", findings: vr.findings });
        continue;
      }
      // ok:true: la piece se acepta, pero guardamos sus findings (warns) para
      // que viajen en el resultado built. vr.findings puede traer warns como
      // executes-code (declarado), egress, no-manifest, etc.
      valid.push({ name, absDir, findings: vr.findings });
      continue;
    }
    valid.push({ name, absDir });
  }

  // T2_SANDBOX=1 -> bundle + extraccion de metadata DENTRO del sandbox bwrap
  // (sandbox-build.sh modo "process" -> sandbox-process.mjs). El host lee
  // metadata.json; NUNCA hace require del bundle no confiable.
  // Sin T2_SANDBOX -> build + extractMetadataFromBundle in-process (pieces confiables).
  const useSandbox = process.env.T2_SANDBOX === "1";
  const inputs: PieceMetadataInput[] = [];
  for (const { name, absDir, findings } of valid) {
    try {
      // Instala deps de terceros (no @activepieces/*) en pieceDir/node_modules
      // ANTES del bundle, para que esbuild resuelva imports como `jsonata`.
      // SOLO en modo sandbox (T2_SANDBOX=1, repos NO confiables): su node_modules
      // no viene en el source importado. En modo in-process (pieces confiables
      // del workspace ~/ap) las deps ya estan resueltas via hoisting del
      // workspace (node_modules gestionado por bun); correr npm install ahi
      // rompe (arborist choca con node_modules/.bun) y es innecesario.
      // --ignore-scripts: el codigo de la piece (no confiable) solo correra
      // luego DENTRO del sandbox; aqui solo se baja, no se ejecuta.
      if (useSandbox) {
        try {
          installThirdPartyDeps(absDir);
        } catch (e) {
          rejected.push({
            name,
            reason: "deps-install-failed",
            findings: [{ level: "error", code: "deps-install-failed", message: (e as Error).message }],
          });
          continue;
        }
      }
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
        // Propaga los findings (warns) de la validacion que paso, para que el
        // operador VEA al importar capacidades declaradas (ej. executes-code).
        // findings es undefined cuando validate=false -> se omite en el JSON.
        ...(findings !== undefined ? { findings } : {}),
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