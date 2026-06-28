/**
 * Sample piece metadata, structurally identical to what `piece.metadata()`
 * returns in Activepieces. Used to run/validate the OKF emitter standalone,
 * before wiring real piece-loading from the built monorepo.
 */
import type { PieceMetadataInput } from '../types.js';

export const samplePieces: PieceMetadataInput[] = [
  {
    name: 'slack',
    displayName: 'Slack',
    description: 'Send messages and interact with Slack channels and users.',
    version: '0.8.4',
    categories: ['COMMUNICATION'],
    authors: ['activepieces'],
    auth: { type: 'OAUTH2', displayName: 'Connection', required: true },
    actions: {
      send_channel_message: {
        name: 'send_channel_message',
        displayName: 'Send Message To A Channel',
        description: 'Send a message to a channel.',
        requireAuth: true,
        audience: 'both',
        aiMetadata: {
          description:
            'Post a text message to a Slack channel. Returns the message timestamp.',
          idempotent: false,
        },
        props: {
          channel: {
            type: 'DROPDOWN',
            displayName: 'Channel',
            description: 'The channel to send the message to.',
            required: true,
          },
          text: {
            type: 'LONG_TEXT',
            displayName: 'Message',
            description: 'The text of the message.',
            required: true,
          },
        },
      },
      // human-only action: should be EXCLUDED from the agent catalog
      manage_admin_settings: {
        name: 'manage_admin_settings',
        displayName: 'Manage Admin Settings',
        description: 'Internal admin-only action.',
        requireAuth: true,
        audience: 'human',
        props: {},
      },
    },
    triggers: {
      new_message: {
        name: 'new_message',
        displayName: 'New Message',
        description: 'Fires when a new message is posted to a channel.',
        requireAuth: true,
        strategy: 'WEBHOOK',
        audience: 'both',
        props: {
          channel: {
            type: 'DROPDOWN',
            displayName: 'Channel',
            description: 'Channel to watch.',
            required: true,
          },
        },
      },
    },
  },
  {
    name: 'http',
    displayName: 'HTTP',
    description: 'Make HTTP requests to any URL.',
    version: '1.2.0',
    categories: ['CORE'],
    authors: ['activepieces'],
    // no auth: connection reference must NOT be required in the docs
    actions: {
      send_request: {
        name: 'send_request',
        displayName: 'Send HTTP Request',
        description: 'Send an HTTP request and return the response.',
        requireAuth: false,
        audience: 'both',
        aiMetadata: {
          description:
            'Perform an HTTP request (GET/POST/...) against an arbitrary URL.',
          idempotent: false,
        },
        props: {
          method: {
            type: 'DROPDOWN',
            displayName: 'Method',
            description: 'HTTP method.',
            required: true,
          },
          url: {
            type: 'SHORT_TEXT',
            displayName: 'URL',
            description: 'Target URL.',
            required: true,
          },
          body: {
            type: 'JSON',
            displayName: 'Body',
            description: 'Request body for POST/PUT.',
            required: false,
          },
        },
      },
    },
    triggers: {},
  },
];
