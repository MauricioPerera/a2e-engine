import { createAction } from '@activepieces/pieces-framework';

// Proves the credential reached the piece WITHOUT leaking the secret:
// returns the type of context.auth and only the last 4 chars of the apiKey.
export const whoami = createAction({
  name: 'whoami',
  displayName: 'Who am I',
  description: 'Returns proof that the connection credential was received in context.auth.',
  requireAuth: true,
  props: {},
  async run(context) {
    const auth: unknown = context.auth;
    // Unwrap whichever shape the engine delivers:
    //  - plain string (SecretText, context v0)
    //  - { type: 'SECRET_TEXT', secret_text } (SecretText, context v1)
    //  - { apiKey } / { props: { apiKey } } (CustomAuth)
    const a = auth as
      | { secret_text?: string; apiKey?: string; props?: { apiKey?: string } }
      | string
      | null
      | undefined;
    const secret =
      typeof a === 'string'
        ? a
        : a?.secret_text ?? a?.apiKey ?? a?.props?.apiKey;
    return {
      receivedAuthType: typeof auth,
      receivedSecret: secret !== undefined,
      apiKeyTail: String(secret ?? '').slice(-4),
    };
  },
});
