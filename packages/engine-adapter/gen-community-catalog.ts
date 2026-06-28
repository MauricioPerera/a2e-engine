// For each bundled community piece: require its index.cjs, find the createPiece
// export, call .metadata(), normalize to PieceMetadataInput, then run the real
// okf-generator over the array and write the catalog to community-catalog/.
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { generateOkfCatalog } from '../okf-generator/src/okf-generator.ts';
import type { PieceMetadataInput, PieceAuthSummary } from '../okf-generator/src/types.ts';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIECES_ROOT = path.join(__dirname, 'community-pieces', 'pieces');
const OUT = path.join(__dirname, 'community-catalog');

function normalizeAuth(auth: any): PieceAuthSummary | undefined {
  if (!auth) return undefined;
  // Some pieces expose multiple auth options as an array; take the first.
  const a = Array.isArray(auth) ? auth[0] : auth;
  if (!a || !a.type) return undefined;
  return {
    type: a.type,
    displayName: a.displayName,
    description: a.description,
    required: a.required,
  };
}

function findPieceExport(mod: any): any {
  if (mod?.default && typeof mod.default.metadata === 'function') return mod.default;
  for (const k of Object.keys(mod)) {
    if (mod[k] && typeof mod[k].metadata === 'function') return mod[k];
  }
  return null;
}

// Each bundled piece lives at:
//   community-pieces/pieces/@scope/piece-<name>-<version>/node_modules/@scope/piece-<name>/
const entries: { dir: string; scope: string }[] = [];
for (const scope of fs.readdirSync(PIECES_ROOT)) {
  const scopeDir = path.join(PIECES_ROOT, scope);
  if (!fs.statSync(scopeDir).isDirectory()) continue;
  for (const pv of fs.readdirSync(scopeDir)) {
    entries.push({ dir: path.join(scopeDir, pv), scope });
  }
}

const inputs: PieceMetadataInput[] = [];
const report: any[] = [];

for (const { dir, scope } of entries) {
  const nmScope = path.join(dir, 'node_modules', scope);
  const pkgName = fs.readdirSync(nmScope)[0]; // e.g. piece-json
  const pkgDir = path.join(nmScope, pkgName);
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
  const indexCjs = path.join(pkgDir, 'index.cjs');
  try {
    const mod = require(indexCjs);
    const piece = findPieceExport(mod);
    if (!piece) throw new Error('no createPiece export with .metadata()');
    const md: any = piece.metadata();
    const input: PieceMetadataInput = {
      name: pkg.name,
      displayName: md.displayName,
      description: md.description ?? '',
      version: pkg.version,
      logoUrl: md.logoUrl,
      categories: md.categories,
      authors: md.authors,
      auth: normalizeAuth(md.auth),
      actions: md.actions ?? {},
      triggers: md.triggers ?? {},
    };
    inputs.push(input);
    report.push({
      piece: pkg.name,
      version: pkg.version,
      auth: input.auth?.type ?? 'NONE',
      actions: Object.keys(input.actions).length,
      triggers: Object.keys(input.triggers).length,
      ok: true,
    });
  } catch (e: any) {
    report.push({ piece: pkg.name, ok: false, error: e.message });
  }
}

const files = generateOkfCatalog(inputs);

// Wipe + write
fs.rmSync(OUT, { recursive: true, force: true });
for (const f of files) {
  const dest = path.join(OUT, f.path);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, f.content);
}

console.log('=== PIECE METADATA REPORT ===');
for (const r of report) console.log(JSON.stringify(r));
console.log(`\nPieces into catalog: ${inputs.length}/${entries.length}`);
console.log(`OKF files written: ${files.length} -> ${OUT}`);
