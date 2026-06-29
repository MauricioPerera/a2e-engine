// Handshake harness: launches run-mcp.sh over stdio exactly like LM Studio
// would (StdioClientTransport spawning bash run-mcp.sh), then runs
// initialize + listTools and asserts 11 tools. Also does a raw stdout capture
// to PROVE there is no noise before the first JSON-RPC frame on stdout.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';

const PKG = '/home/administrador/product/packages/a2e-mcp-server';
const EXPECTED = ['retrieve_catalog','get_piece','list_connections','execute_workflow','save_workflow','list_workflows','run_saved_workflow','query_knowledge','query_runs','retrieve_pieces','retrieve_actions'];
let failed = false;
const ok = (label, cond, extra='') => {
  const tag = cond ? 'PASS' : 'FAIL';
  console.error(`${tag}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failed = true;
};

// ---- Part A: raw stdout capture, prove no noise before JSON-RPC ----
// Send initialize immediately (server only emits stdout in response to a
// request), then inspect the VERY FIRST stdout byte: it must be '{' (0x7B),
// i.e. a JSON-RPC frame, not a banner/log line.
async function rawStdoutCheck() {
  return new Promise((resolve) => {
    const child = spawn('bash', ['run-mcp.sh'], { cwd: PKG, env: process.env });
    let buf = Buffer.alloc(0);
    let firstByteChecked = false;
    let done = false;
    const finish = () => { if (!done) { done = true; try { child.kill('SIGKILL'); } catch {} resolve(); } };
    const init = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-probe', version: '0.0.1' } },
    }) + '\n';
    // send initialize right away so the server has something to respond to
    child.stdin.on('error', () => {});
    child.stdin.write(init);
    child.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!firstByteChecked && buf.length > 0) {
        firstByteChecked = true;
        const first = buf[0];
        const head = buf.slice(0, 80).toString();
        ok('raw stdout first byte is 0x7B ({)', first === 0x7B, `got 0x${first.toString(16)} head=${JSON.stringify(head)}`);
        finish();
      }
    });
    child.stderr.on('data', () => {}); // discard stderr noise (stderr is allowed)
    child.on('error', (e) => { ok('raw spawn ok', false, e.message); finish(); });
    setTimeout(finish, 8000);
  });
}

// ---- Part B: real StdioClientTransport handshake (initialize + listTools) ----
async function clientHandshake() {
  const transport = new StdioClientTransport({
    command: 'bash',
    args: ['run-mcp.sh'],
    cwd: PKG,
    env: { ...process.env, A2E_API_BASE: process.env.A2E_API_BASE ?? 'http://localhost:8080' },
  });
  const client = new Client({ name: 'handshake-probe', version: '0.0.1' }, { capabilities: {} });
  // connect() performs the initialize handshake internally in this SDK version.
  await client.connect(transport);
  const sv = client.getServerVersion();
  ok('initialize: serverInfo', !!(sv && sv.name), JSON.stringify(sv));
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name).sort();
  ok('listTools count == 11', tools.length === 11, `got ${tools.length}`);
  ok('all expected tools present', EXPECTED.every(n => names.includes(n)) && names.length === EXPECTED.length, JSON.stringify(names));
  await client.close();
  try { await transport.close(); } catch {}
}

console.error('=== Part A: raw stdout noise check ===');
await rawStdoutCheck();
console.error('\n=== Part B: StdioClientTransport handshake ===');
await clientHandshake();
console.error('\nRESULT: ' + (failed ? 'FAIL' : 'ALL PASS'));
process.exit(failed ? 1 : 0);