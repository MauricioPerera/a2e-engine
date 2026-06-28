// sandbox-process.mjs — runner que corre ENTERO dentro del sandbox bwrap (T2).
//
// Hace TANTO el bundle COMO la extraccion de metadata del codigo NO CONFIABLE
// de una piece, todo DENTRO del sandbox (red bloqueada, FS confinado via bwrap
// --unshare-all + binds minimos provistos por sandbox-build.sh):
//   1. buildPiece(pieceDir, outRoot)            -> genera index.cjs (esbuild).
//   2. require(indexCjs) + <export>.metadata()   -> EJECUTA el codigo de la piece
//      (top-level del modulo + .metadata()) DENTRO del sandbox. Este es el punto
//      que antes corria in-process en el host (vector abierto).
//   3. serializa el resultado a PieceMetadataInput (mismo shape que
//      extractMetadataFromBundle en build-source.ts) y lo escribe a
//      <pkgDir>/metadata.json. El host lee ese JSON (datos), NUNCA hace require
//      del bundle.
//
// El host solo lee metadata.json: el require del bundle no confiable ocurre
// exclusivamente aqui, dentro de bwrap.
//
// Usage: node sandbox-process.mjs <pieceDir> <outRoot>
//   (invocado por scripts/sandbox-build.sh en modo "process"; mismo AP_REPO env.)
import { createRequire } from "node:module";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildPiece } from "../../engine-adapter/build-piece.mjs";

const require = createRequire(import.meta.url);

// --- espejo de build-source.ts (mismo shape de serializacion) ---

function findPieceExport(mod) {
  const d = mod?.default;
  if (d && typeof d.metadata === "function") return d;
  const dd = d?.default;
  if (dd && typeof dd.metadata === "function") return dd;
  for (const k of Object.keys(mod)) {
    const v = mod[k];
    if (v && typeof v.metadata === "function") return v;
  }
  return null;
}

function serializeProps(props) {
  if (!props || typeof props !== "object") return {};
  const out = {};
  for (const [k, p] of Object.entries(props)) {
    if (!p) continue;
    out[k] = {
      type: p.type ?? "UNKNOWN",
      displayName: p.displayName ?? k,
      description: p.description ?? "",
      required: !!p.required,
      ...(p.options !== undefined ? { options: p.options } : {}),
    };
  }
  return out;
}

function serializeActions(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  for (const [k, a] of Object.entries(obj)) {
    if (!a) continue;
    out[k] = {
      name: a.name ?? k,
      displayName: a.displayName ?? k,
      description: a.description ?? "",
      props: serializeProps(a.props),
      ...(a.requireAuth !== undefined ? { requireAuth: a.requireAuth } : {}),
      ...(a.strategy !== undefined ? { strategy: a.strategy } : {}),
      ...(a.audience !== undefined ? { audience: a.audience } : {}),
      ...(a.aiMetadata !== undefined
        ? {
            aiMetadata: {
              description: a.aiMetadata.description,
              idempotent: a.aiMetadata.idempotent,
            },
          }
        : {}),
    };
  }
  return out;
}

function normalizeAuth(auth) {
  if (!auth) return undefined;
  const a = Array.isArray(auth) ? auth[0] : auth;
  if (!a || !a.type) return undefined;
  return {
    type: a.type,
    displayName: a.displayName,
    description: a.description,
    required: a.required,
  };
}

// Drena operaciones async pendientes que el codigo de la piece haya scheduleado
// al cargar el modulo (p.ej. fetch() a nivel top-level). Para pieces legitimas
// (sin async pendiente) beforeExit dispara de inmediato -> latencia ~0. Para una
// piece maliciosa que lanza fetch, esperamos a que la promesa se settle (en
// sandbox sin red, fetch falla rapido: getaddrinfo EAI_AGAIN porque /etc/resolv.conf
// no esta bind-eado) para que su .catch pueda escribir resultado antes de salir.
// Timeout de seguridad por si queda colgado.
function drainPending(timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      process.off("beforeExit", finish);
      resolve();
    };
    process.on("beforeExit", finish);
    const t = setTimeout(finish, timeoutMs);
    t.unref();
  });
}

// El codigo de la piece (top-level del modulo) puede dejar rechazos de promesas
// sin atrapar (p.ej. un fetch malicioso cuyo rechazo interno de undici/Wasm no
// esta cubierto por el .catch de la piece). node 22 por defecto CRASHEA el
// proceso ante un unhandledRejection. Aqui lo logueamos y NO crasheamos: el
// objetivo es extraer metadata; el comportamiento malicioso ya esta confinado
// por el sandbox (sin red, FS minimo). No maskerea errores del propio runner
// (esos van por main().catch y exit 2): este handler solo atrapa lo que el
// top-level de la piece deja pendiente.
process.on("unhandledRejection", (e) => {
  const msg = e && e.message ? e.message : String(e);
  console.error(`[sandbox-process] piece unhandledRejection (contained): ${msg}`);
});

async function main() {
  const [, , pieceDir, outRoot] = process.argv;
  if (!pieceDir || !outRoot) {
    console.error("usage: node sandbox-process.mjs <pieceDir> <outRoot>");
    process.exit(1);
  }

  // 1. bundle (esbuild) — dentro del sandbox.
  const r = await buildPiece(pieceDir, outRoot);
  const indexCjs = r.indexCjs;
  if (!existsSync(indexCjs)) throw new Error(`buildPiece produced no index.cjs at ${indexCjs}`);

  // 2. require + .metadata() — EJECUTA el codigo de la piece DENTRO del sandbox.
  delete require.cache[indexCjs];
  const mod = require(indexCjs);
  const piece = findPieceExport(mod);
  if (!piece) throw new Error("no createPiece export with .metadata()");
  const md = piece.metadata();
  const pkg = JSON.parse(readFileSync(path.join(r.pkgDir, "package.json"), "utf8"));

  // 3. serializa a PieceMetadataInput (mismo shape que build-source.ts).
  const meta = {
    name: pkg.name,
    displayName: md.displayName ?? pkg.name,
    description: md.description ?? "",
    version: pkg.version,
    ...(md.logoUrl !== undefined ? { logoUrl: md.logoUrl } : {}),
    ...(md.categories !== undefined ? { categories: md.categories } : {}),
    ...(md.authors !== undefined ? { authors: md.authors } : {}),
    auth: normalizeAuth(md.auth),
    actions: serializeActions(md.actions),
    triggers: serializeActions(md.triggers),
  };

  // Drena async pendiente del top-level de la piece (p.ej. fetch malicioso)
  // antes de escribir metadata.json y salir, para que sus side-effects (logs)
  // se completen. Latencia ~0 para pieces sin async.
  await drainPending();

  const metaPath = path.join(r.pkgDir, "metadata.json");
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  console.log(`[sandbox-process] OK ${meta.name}@${meta.version} -> ${metaPath}`);
  // Forzamos salida limpia: si el top-level de la piece dejo sockets/IO pendiente
  // (p.ej. un fetch que no settleo), node no saldria y el timeout de bwrap (90s)
  // lo mataria -> exit no-zero. drainPending ya espero a que el loop se vaciara
  // (beforeExit) o al timeout de seguridad; tras escribir metadata, salimos.
  process.exit(0);
}

main().catch((e) => {
  console.error(`[sandbox-process] FAIL: ${e && e.message ? e.message : String(e)}`);
  process.exit(2);
});