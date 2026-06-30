// Promoción de catálogo: lleva pieces importadas (T2) del estado AISLADO
// (artefactos de /sources/build) al catálogo VIVO en 3 sitios:
//   1) bundles -> promotedDir (layout del engine: pieces/@scope/piece-VERSION/...)
//      para que el engine las cargue en ejecución (AP_CUSTOM_PIECES_PATHS).
//   2) docs OKF -> fullCatalogDir (copia dirs @scope/*) para discovery nivel 2.
//   3) catalog-summary.json -> rebuild multi-scope para discovery nivel 1.
//
// Flujo: build a outRoot+catalogOut TEMPORAL aislado (honra T2_SANDBOX del env,
// igual que /sources/build) -> copia bundles -> fusiona OKF -> rebuild summary.
// Idempotente: re-promover misma versión sobreescribe el mismo layout. NO toca
// el index.md raíz del full-catalog (es el índice agregado de TODO el catálogo;
// el de catalogOut solo lista las promovidas).
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, cpSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildSelectedPieces,
  type BuiltPiece,
  type RejectedPiece,
} from "../../piece-source-manager/src/build-source.js";

// keep import referenced (createRequire used for nothing else here, but mirrors
// the sibling modules' style and keeps the engine-env invariant explicit).
void createRequire;

export interface PromotePieceResult {
  name: string;
  version: string;
  dir: string;
  findings?: { level: string; code: string; message: string }[];
}

export interface PromoteSourceResult {
  promoted: PromotePieceResult[];
  rejected: RejectedPiece[];
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export async function promoteSource(opts: {
  sourceDir: string;
  pieceNames: string[];
  promotedDir: string;
  fullCatalogDir: string;
  catalogSummaryPath: string;
}): Promise<PromoteSourceResult> {
  const root = expandHome(opts.sourceDir);
  const promotedDir = path.resolve(opts.promotedDir);
  const fullCatalogDir = path.resolve(opts.fullCatalogDir);
  const catalogSummaryPath = path.resolve(opts.catalogSummaryPath);
  mkdirSync(promotedDir, { recursive: true });
  mkdirSync(fullCatalogDir, { recursive: true });
  mkdirSync(path.dirname(catalogSummaryPath), { recursive: true });

  // outRoot + catalogOut TEMPORALES aislados. buildSelectedPieces honra
  // T2_SANDBOX del env (sandbox bwrap si T2_SANDBOX=1, in-process si no).
  const outRoot = mkdtempSync(path.join(os.tmpdir(), "promote-out-"));
  const catalogOut = mkdtempSync(path.join(os.tmpdir(), "promote-cat-"));
  try {
    const res = await buildSelectedPieces({
      sourceDir: root,
      pieceNames: opts.pieceNames,
      outRoot,
      catalogOut,
      validate: true,
    });

    // 1) Bundles -> promotedDir. outRoot/pieces contiene SOLO las pieces
    //    bundleadas (las válidas). Copia cada @scope dir preservando el layout
    //    del engine (pieces/@scope/piece-name-VERSION/node_modules/...). overwrite
    //    -> re-promover misma versión sobreescribe; otra versión coexiste.
    const srcPiecesDir = path.join(outRoot, "pieces");
    const dstPiecesDir = path.join(promotedDir, "pieces");
    if (existsSync(srcPiecesDir)) {
      mkdirSync(dstPiecesDir, { recursive: true });
      for (const scope of readdirSync(srcPiecesDir, { withFileTypes: true })) {
        if (!scope.isDirectory()) continue;
        cpSync(path.join(srcPiecesDir, scope.name), path.join(dstPiecesDir, scope.name), {
          recursive: true,
          overwrite: true,
        });
      }
    }

    // 2) OKF -> fullCatalogDir. Copia los dirs @scope/* (pieces). NO copia el
    //    index.md raíz de catalogOut (índice agregado de solo las promovidas);
    //    el del full-catalog es el de todo el catálogo y se conserva.
    for (const entry of readdirSync(catalogOut, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("@")) continue;
      cpSync(path.join(catalogOut, entry.name), path.join(fullCatalogDir, entry.name), {
        recursive: true,
        overwrite: true,
      });
    }

    // 3) Rebuild catalog-summary.json sobre fullCatalogDir (multi-scope).
    //    build-catalog-summary.mjs [catalogRoot] [outPath].
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const bcs = path.resolve(scriptDir, "../../okf-retriever/build-catalog-summary.mjs");
    execFileSync(process.execPath, [bcs, fullCatalogDir, catalogSummaryPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });

    const promoted: PromotePieceResult[] = res.built.map((b: BuiltPiece) => ({
      name: b.name,
      version: b.version,
      dir: b.dir,
      ...(b.findings !== undefined ? { findings: b.findings } : {}),
    }));
    return { promoted, rejected: res.rejected };
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
    rmSync(catalogOut, { recursive: true, force: true });
  }
}