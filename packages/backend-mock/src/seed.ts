import { Vault } from './vault.js';

/**
 * Carga credenciales demo (Fase 1, sin OAuth2) en el vault para el proyecto dado.
 * Tres conexiones: una SECRET_TEXT, una CUSTOM_AUTH y una NO_AUTH.
 * Función lineal: tres put secuenciales, sin ramas.
 */
export function seedVault(vault: Vault, projectId: string): void {
  vault.put({
    externalId: 'openai',
    projectId,
    pieceName: 'openai',
    displayName: 'OpenAI',
    value: { type: 'SECRET_TEXT', secret_text: 'sk-demo-xxx' },
  });
  vault.put({
    externalId: 'my-api',
    projectId,
    pieceName: 'my-api',
    displayName: 'My API',
    value: {
      type: 'CUSTOM_AUTH',
      props: { apiKey: 'demo', baseUrl: 'https://api.example.com' },
    },
  });
  vault.put({
    externalId: 'http',
    projectId,
    pieceName: 'http',
    displayName: 'HTTP (no auth)',
    value: { type: 'NO_AUTH' },
  });
}