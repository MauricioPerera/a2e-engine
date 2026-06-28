// Bundles the chosen representative community pieces into a common root.
import path from 'path';
import { fileURLToPath } from 'url';
import { buildPiece } from './build-piece.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AP_COMMUNITY = '/home/administrador/ap/packages/pieces/community';
const OUT = path.join(__dirname, 'community-pieces');

const CHOSEN = ['json', 'flow-helper', 'slack', 'github', 'airtable'];

const results = [];
for (const name of CHOSEN) {
  try {
    const r = await buildPiece(path.join(AP_COMMUNITY, name), OUT);
    console.log(`[OK]   ${name.padEnd(14)} -> ${r.name}@${r.version}`);
    results.push({ name, ...r, ok: true });
  } catch (e) {
    console.log(`[FAIL] ${name.padEnd(14)} -> ${e.message}`);
    results.push({ name, ok: false, error: e.message });
  }
}
console.log('\nOUT ROOT =', OUT);
console.log('OK:', results.filter(r => r.ok).length, '/', CHOSEN.length);
