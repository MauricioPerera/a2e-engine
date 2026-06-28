// Batch OKF catalog generator for ALL Activepieces community pieces.
// For each piece dir under ~/ap/packages/pieces/community, spawns a child
// (load-one-piece.mjs) that bundles + requires + extracts .metadata() and
// prints a JSON-safe PieceMetadataInput. The parent isolates each piece with
// a per-piece timeout (kill on timeout) and a global wall-clock cap, then feeds
// the successful inputs to the real okf-generator and writes full-catalog/.
// A CATALOG-COVERAGE.md reports OK / failed + reasons.
import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { generateOkfCatalog } from '../okf-generator/src/okf-generator.ts';
import type { PieceMetadataInput } from '../okf-generator/src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AP_REPO = process.env.AP_REPO || path.join(os.homedir(), 'ap');
const COMMUNITY_ROOT = path.join(AP_REPO, 'packages/pieces/community');
const OUT = path.join(__dirname, 'full-catalog');
const COVERAGE = path.join(__dirname, 'CATALOG-COVERAGE.md');
const CHILD = path.join(__dirname, 'load-one-piece.mjs');
const NODE = '/home/administrador/.hermes/node/bin/node';

const PER_PIECE_TIMEOUT_MS = 20_000;
const WALL_CLOCK_CAP_MS = 18 * 60_000; // 18 min
const CONCURRENCY = 6;

interface ChildResult {
  ok: boolean;
  input?: PieceMetadataInput;
  counts?: { actions: number; triggers: number; auth: string };
  error?: string;
  reason?: string;
}

function runOnePiece(pieceDir: string, pieceName: string, deadline: number): Promise<{ pieceName: string; result: ChildResult | null }> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    const finish = (result: ChildResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      resolve({ pieceName, result });
    };

    const child = spawn(NODE, [CHILD, pieceDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'timeout', error: `timeout >${PER_PIECE_TIMEOUT_MS}ms` });
    }, PER_PIECE_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', () => { /* swallow child stderr noise */ });
    child.on('error', () => finish({ ok: false, reason: 'spawn-fail', error: 'spawn error' }));
    child.on('close', () => {
      const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
      if (!line) return finish({ ok: false, reason: 'no-output', error: 'no JSON from child' });
      try {
        const parsed = JSON.parse(line) as ChildResult;
        finish(parsed);
      } catch (e: any) {
        finish({ ok: false, reason: 'parse-fail', error: 'bad JSON: ' + (e?.message ?? String(e)) });
      }
    });

    // Global deadline guard: don't even keep waiting past the cap.
    const remaining = deadline - Date.now();
    if (remaining <= 0) finish({ ok: false, reason: 'wall-cap', error: 'global wall-clock cap reached' });
  });
}

async function main() {
  const start = Date.now();
  const deadline = start + WALL_CLOCK_CAP_MS;

  const dirs = fs.readdirSync(COMMUNITY_ROOT)
    .filter((d) => fs.statSync(path.join(COMMUNITY_ROOT, d)).isDirectory())
    .sort();

  const total = dirs.length;
  console.log(`[gen-full-catalog] ${total} community pieces; concurrency=${CONCURRENCY}; per-piece=${PER_PIECE_TIMEOUT_MS}ms; cap=${WALL_CLOCK_CAP_MS}ms`);

  const inputs: PieceMetadataInput[] = [];
  const failures: { name: string; reason: string; error: string }[] = [];
  let processed = 0;
  let stopped = false;

  // Simple concurrency pool.
  let idx = 0;
  async function worker() {
    while (idx < dirs.length && !stopped) {
      if (Date.now() >= deadline) { stopped = true; break; }
      const name = dirs[idx++];
      const pieceDir = path.join(COMMUNITY_ROOT, name);
      const { result } = await runOnePiece(pieceDir, name, deadline);
      processed++;
      if (result?.ok && result.input) {
        inputs.push(result.input);
        if (inputs.length % 25 === 0) {
          console.log(`[gen-full-catalog] progress: ${processed}/${total} done, ${inputs.length} OK, ${failures.length} failed (${Math.round((Date.now() - start) / 1000)}s)`);
        }
      } else {
        failures.push({ name, reason: result?.reason ?? 'unknown', error: (result?.error ?? '').slice(0, 200) });
      }
      if (processed % 50 === 0) {
        console.log(`[gen-full-catalog] ${processed}/${total} | OK=${inputs.length} FAIL=${failures.length} | ${Math.round((Date.now() - start) / 1000)}s`);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  const wallHit = stopped && idx < dirs.length;
  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`[gen-full-catalog] load phase done in ${elapsed}s: attempted=${processed} OK=${inputs.length} FAIL=${failures.length}${wallHit ? ` (WALL-CAP hit, ${dirs.length - idx} not attempted)` : ''}`);

  // Generate + write OKF catalog.
  const files = generateOkfCatalog(inputs);
  fs.rmSync(OUT, { recursive: true, force: true });
  for (const f of files) {
    const dest = path.join(OUT, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.content);
  }

  // Aggregate failure reasons.
  const reasonCounts: Record<string, number> = {};
  for (const f of failures) reasonCounts[f.reason] = (reasonCounts[f.reason] ?? 0) + 1;
  const reasonRows = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]);

  const okfFiles = files.length;
  const totalActions = inputs.reduce((s, p) => s + Object.keys(p.actions).length, 0);
  const totalTriggers = inputs.reduce((s, p) => s + Object.keys(p.triggers).length, 0);

  // CATALOG-COVERAGE.md
  const lines: string[] = [];
  lines.push('# OKF Catalog Coverage — Activepieces Community Pieces', '');
  lines.push(`Generated: ${new Date().toISOString()}`, '');
  lines.push('## Summary', '');
  lines.push(`- **Total community pieces:** ${total}`);
  lines.push(`- **Attempted:** ${processed}`);
  lines.push(`- **Loaded OK (into catalog):** ${inputs.length}`);
  lines.push(`- **Failed:** ${failures.length}`);
  lines.push(`- **OKF files generated:** ${okfFiles}`);
  lines.push(`- **Total actions covered:** ${totalActions}`);
  lines.push(`- **Total triggers covered:** ${totalTriggers}`);
  lines.push(`- **Wall-clock elapsed:** ${elapsed}s${wallHit ? ` (stopped at ${WALL_CLOCK_CAP_MS / 60000}min cap; ${dirs.length - idx} pieces NOT attempted)` : ''}`);
  lines.push(`- **Coverage of attempted:** ${processed ? ((inputs.length / processed) * 100).toFixed(1) : '0'}%`);
  lines.push(`- **Coverage of total:** ${((inputs.length / total) * 100).toFixed(1)}%`, '');

  lines.push('## Failure reasons (grouped)', '');
  lines.push('| Reason | Count |', '| --- | --- |');
  for (const [r, c] of reasonRows) lines.push(`| ${r} | ${c} |`);
  lines.push('');

  lines.push('## Failed pieces', '');
  lines.push('| Piece | Reason | Error (truncated) |', '| --- | --- | --- |');
  for (const f of failures.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    const err = (f.error || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${f.name} | ${f.reason} | ${err.slice(0, 160)} |`);
  }
  lines.push('');

  lines.push('## Loaded pieces (OK)', '');
  lines.push(`_${inputs.length} pieces_`, '');
  lines.push('| Piece | Actions | Triggers | Auth |', '| --- | --- | --- | --- |');
  for (const p of inputs.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`| ${p.name} | ${Object.keys(p.actions).length} | ${Object.keys(p.triggers).length} | ${p.auth?.type ?? 'none'} |`);
  }
  lines.push('');

  fs.writeFileSync(COVERAGE, lines.join('\n'));
  console.log(`[gen-full-catalog] OKF files: ${okfFiles} -> ${OUT}`);
  console.log(`[gen-full-catalog] coverage report -> ${COVERAGE}`);
  console.log(`[gen-full-catalog] reasons: ${JSON.stringify(reasonCounts)}`);
}

main().catch((e) => { console.error('[gen-full-catalog] FATAL:', e); process.exit(1); });