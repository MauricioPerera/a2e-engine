// Metadata of the demo pieces actually bundled & executable in this product:
//  - @activepieces/piece-json   (convert_text_to_json)  -> custom-pieces/pieces
//  - @automators/piece-echo-auth     (whoami, SecretText)    -> custom-pieces-echo/dist/pieces
// Structurally compatible with okf-generator's PieceMetadataInput so the same
// OKF emitter that runs on the sample fixture runs on the real demo pieces.
import type { PieceMetadataInput } from '../../okf-generator/src/types.js';

export const demoPieces: PieceMetadataInput[] = [
  {
    name: '@activepieces/piece-json',
    displayName: 'JSON',
    description: 'Parse and stringify JSON without leaving the flow.',
    version: '0.1.8',
    categories: ['CORE'],
    authors: ['activepieces'],
    actions: {
      convert_text_to_json: {
        name: 'convert_text_to_json',
        displayName: 'Convert Text to JSON',
        description: 'Parse a JSON-encoded string into a JSON object.',
        audience: 'both',
        aiMetadata: {
          description:
            'Parse a JSON string (input prop "text") and return the resulting object. No auth.',
          idempotent: true,
        },
        props: {
          text: {
            type: 'LONG_TEXT',
            displayName: 'Text',
            description: 'The JSON-encoded text to parse, e.g. {"a":1}.',
            required: true,
          },
        },
      },
    },
    triggers: {},
  },
  {
    name: '@automators/piece-echo-auth',
    displayName: 'Echo Auth',
    description: 'Echoes proof that a connection credential reached the piece.',
    version: '0.1.0',
    categories: ['CORE'],
    authors: ['myorg'],
    auth: {
      type: 'SECRET_TEXT',
      displayName: 'API Key',
      description: 'API key; the piece returns only its last 4 chars.',
      required: true,
    },
    actions: {
      whoami: {
        name: 'whoami',
        displayName: 'Who am I',
        description:
          'Returns proof that the connection credential was received in context.auth.',
        requireAuth: true,
        audience: 'both',
        aiMetadata: {
          description:
            'Prove a SECRET_TEXT connection reached the piece. Pass a connection named e.g. "my-echo-conn". Returns apiKeyTail (last 4 chars).',
          idempotent: true,
        },
        props: {},
      },
    },
    triggers: {},
  },
  {
    name: '@automators/piece-textkit',
    displayName: 'TextKit',
    description: 'Small text-transform toolkit (reverse, etc.) with no auth.',
    version: '0.1.0',
    categories: ['CORE'],
    authors: ['myorg'],
    actions: {
      reverse_text: {
        name: 'reverse_text',
        displayName: 'Reverse Text',
        description: 'Reverse the characters of the input text.',
        requireAuth: false,
        audience: 'both',
        aiMetadata: {
          description:
            'Reverse the characters of the input text (prop "text"). No auth, no network; idempotent pure transform.',
          idempotent: true,
        },
        props: {
          text: {
            type: 'LONG_TEXT',
            displayName: 'Text',
            description: 'The text whose characters will be reversed.',
            required: true,
          },
        },
      },
    },
    triggers: {},
  },
];
