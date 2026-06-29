// Harness: runs @automators/piece-shell action `run` through the real engine
// via piece-sdk testPieceAction, and prints raw status/output/error so the
// allowlist boundary is auditable (echo passes; rm is blocked BEFORE exec).
import path from 'node:path';
import { testPieceAction } from '../piece-sdk/src/test-piece.ts';

const piecesPath = path.resolve(process.env.HOME as string, 'product/packages/engine-adapter/custom-pieces-shell/dist');

const cases = [
  {
    name: 'echo-hello-a2e',
    actionName: 'run',
    input: { bin: 'echo', args: ['hello a2e'] },
    expectStatus: 'SUCCEEDED',
    expect: { exitCode: 0, stdout: 'hello a2e\n' },
  },
  {
    name: 'echo-determinista',
    actionName: 'run',
    input: { bin: 'echo', args: ['determinista'] },
    expectStatus: 'SUCCEEDED',
    expect: { exitCode: 0, stdout: 'determinista\n' },
  },
  {
    name: 'rm-blocked-by-allowlist',
    actionName: 'run',
    input: { bin: 'rm', args: ['-rf', '/tmp/x'] },
    expectStatus: 'FAILED',
  },
];

const { results, summary } = await testPieceAction({
  piecesPath,
  pieceName: '@automators/piece-shell',
  pieceVersion: '0.1.0',
  cases,
});

for (const line of summary.lines) console.log(line);
console.log(`-- summary: ${summary.passed}/${summary.total} passed, ${summary.failed} failed`);
for (const r of results) {
  console.log(`--- ${r.name} ---`);
  console.log(`  status: ${r.status ?? '?'}`);
  console.log(`  passed: ${r.passed}`);
  console.log(`  error:  ${r.error ?? '(none)'}`);
  console.log(`  mismatches: ${JSON.stringify(r.mismatches)}`);
}