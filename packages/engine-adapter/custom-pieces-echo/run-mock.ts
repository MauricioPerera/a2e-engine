// Starts the backend-mock seeded with the 'my-echo-conn' SECRET_TEXT credential
// for the echo-auth e2e test. Prints AUDIT_DUMP lines on SIGTERM so the runner
// can prove the engine dereferenced the connection over HTTP.
import { Vault } from '../../backend-mock/src/vault.js';
import { MemoryStore } from '../../backend-mock/src/store.js';
import { MemoryFileStore } from '../../backend-mock/src/files.js';
import { createServer } from '../../backend-mock/src/server.js';

const PORT = Number(process.env.PORT ?? '3997');
const ENGINE_TOKEN = 'dev-engine-token';
const PROJECT_ID = 'demo-project';
const SECRET = 'sk-test-ABCD1234';

const vault = new Vault('dev-master-key-16chars');
vault.put({
  externalId: 'my-echo-conn',
  projectId: PROJECT_ID,
  pieceName: '@automators/piece-echo-auth',
  displayName: 'Echo Auth Connection',
  value: { type: 'SECRET_TEXT', secret_text: SECRET },
});

const server = createServer({
  vault,
  store: new MemoryStore(),
  files: new MemoryFileStore(),
  engineToken: ENGINE_TOKEN,
  project: { id: PROJECT_ID, externalId: 'demo-ext' },
});

function dumpAuditAndExit(): void {
  console.log('AUDIT_DUMP_START');
  console.log(JSON.stringify(vault.audit));
  console.log('AUDIT_DUMP_END');
  server.close(() => process.exit(0));
}

process.on('SIGTERM', dumpAuditAndExit);
process.on('SIGINT', dumpAuditAndExit);

server.listen(PORT, () => {
  console.log(`echo-mock listening on http://localhost:${PORT} (seeded my-echo-conn)`);
});
