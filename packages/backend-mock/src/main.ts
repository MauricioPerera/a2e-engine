import { Vault } from './vault.js';
import { MemoryStore } from './store.js';
import { MemoryFileStore } from './files.js';
import { createServer } from './server.js';
import { seedVault } from './seed.js';

function env(key: string, fallback: string): string {
  const value = process.env[key];
  return value && value.length > 0 ? value : fallback;
}

const engineToken = env('AP_ENGINE_TOKEN', 'dev-engine-token');
const port = Number(env('PORT', '3000'));
const masterKey = env('VAULT_MASTER_KEY', 'dev-master-key-16chars');
const projectId = env('PROJECT_ID', 'demo-project');
const projectExternalId = env('PROJECT_EXTERNAL_ID', 'demo-ext');

const vault = new Vault(masterKey);
const store = new MemoryStore();
const files = new MemoryFileStore();

seedVault(vault, projectId);

const server = createServer({
  vault,
  store,
  files,
  engineToken,
  project: { id: projectId, externalId: projectExternalId },
});

server.listen(port, () => {
  console.log(`engine-backend-mock listening on http://localhost:${port}`);
});