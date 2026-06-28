/**
 * CLI: writes the OKF catalog to disk.
 *
 *   tsx src/cli.ts [outDir]        (default outDir: ./out/catalog)
 *
 * Currently sourced from the sample fixture. To generate from real pieces,
 * replace `samplePieces` with metadata collected via `piece.metadata()` from
 * the built Activepieces packages (see README, "Wiring real pieces").
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { generateOkfCatalog } from './okf-generator.js';
import { samplePieces } from './fixtures/sample-pieces.js';
import type { PieceMetadataInput } from './types.js';

async function writeCatalog(
  pieces: PieceMetadataInput[],
  outDir: string,
): Promise<void> {
  const files = generateOkfCatalog(pieces);
  await rm(outDir, { recursive: true, force: true });
  for (const file of files) {
    const fullPath = join(outDir, file.path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, file.content, 'utf8');
  }
  console.log(
    `OKF catalog written: ${files.length} file(s) for ${pieces.length} piece(s) -> ${outDir}`,
  );
}

const outDir = process.argv[2] ?? './out/catalog';
writeCatalog(samplePieces, outDir).catch((err) => {
  console.error(err);
  process.exit(1);
});
