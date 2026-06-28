// start-mock — arranca un backend-mock de un solo uso, siembra UNA connection en el
// vault y escucha en <port>. Lo levanta testPieceAction (rama connection) como child
// process; imprime "LISTENING <port>" para que el padre detecte readiness.
//
// Args: port engineToken projectId externalId pieceName displayName valueJsonBase64
//   valueJsonBase64 = AppConnectionValue (SECRET_TEXT | BASIC_AUTH | CUSTOM_AUTH | NO_AUTH)
//   codificada en base64 UTF-8.
//
// El motor llama a internalApiUrl=http://localhost:<port>/ con Authorization: Bearer
// <engineToken> para resolver {{connections["<externalId>"]}}. projectId debe coincidir
// con el que usa el engine (buildConstants.projectId), normalmente "demo-project".
import { Vault } from "../../backend-mock/src/vault.js";
import { MemoryStore } from "../../backend-mock/src/store.js";
import { MemoryFileStore } from "../../backend-mock/src/files.js";
import { createServer } from "../../backend-mock/src/server.js";

const [portStr, engineToken, projectId, externalId, pieceName, displayName, valueB64] =
  process.argv.slice(2);
if (!portStr || !engineToken || !projectId || !externalId || !pieceName || !displayName || !valueB64) {
  console.error("usage: tsx start-mock.ts <port> <engineToken> <projectId> <externalId> <pieceName> <displayName> <valueJsonBase64>");
  process.exit(1);
}

const port = Number(portStr);
const value = JSON.parse(Buffer.from(valueB64, "base64").toString("utf-8"));

// master key fija (>=16 chars); coherente con backend-mock. No persiste a disco.
const vault = new Vault("dev-master-key-16chars");
vault.put({ externalId, projectId, pieceName, displayName, value });

const server = createServer({
  vault,
  store: new MemoryStore(),
  files: new MemoryFileStore(),
  engineToken,
  project: { id: projectId, externalId },
});

function shutdown(): void {
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(port, () => {
  // Linea de readiness: el padre lee stdout hasta encontrar "LISTENING <port>".
  console.log(`LISTENING ${port}`);
});
