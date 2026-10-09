import type { McpServer } from '@modelcontextprotocol/server';
import { minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { AlexaClient } from '../client.js';

/**
 * Sign-in tools. Not confirm-gated, deliberately: `begin` changes nothing
 * anywhere (it mints a link and a local PKCE secret), and `finish` can only do
 * anything with a fresh one-time code that exists because the person just
 * signed in to Amazon themselves — that sign-in is the consent, and no model
 * can produce the code on its own.
 */
export function registerLoginTools(server: McpServer, client: AlexaClient): void {
  server.registerTool(
    'alexa_begin_login',
    {
      description:
        'Start signing in to Amazon Alexa (or re-connect a revoked session). Returns a signInUrl on www.amazon.com ' +
        'and a loginId. Give the user the link to open in their OWN browser (a private tab works best on a phone ' +
        'with the Alexa app). After signing in they land on a blank www.amazon.com/ap/maplanding page: ask them to ' +
        'paste that page’s full address, then call alexa_finish_login with it and the loginId. The password never ' +
        'passes through this server. The link works for 15 minutes.',
      annotations: toolAnnotations({ readOnly: false, destructive: false, openWorld: false }),
      inputSchema: z.object({}),
    },
    async () => {
      const { loginId, signInUrl, expiresInMinutes } = await client.browserLogin().begin();
      return minifiedResult({
        loginId,
        signInUrl,
        expiresInMinutes,
        next: 'Have the user open signInUrl, sign in, and paste the address of the page they land on into alexa_finish_login.',
      });
    },
  );

  server.registerTool(
    'alexa_finish_login',
    {
      description:
        'Finish an Alexa sign-in started by alexa_begin_login. Pass the loginId and the full address of the ' +
        'www.amazon.com/ap/maplanding page the user landed on (or just its authorization code). Registers this ' +
        'server as an "alexa-mcp" device on the Amazon account, saves the session, and checks it by reading the ' +
        'device list. Each sign-in link can be finished once; if it fails, start again with alexa_begin_login.',
      annotations: toolAnnotations({ readOnly: false, destructive: true, openWorld: true }),
      inputSchema: z.object({
        loginId: z.string().regex(/^[0-9a-f]{16,64}$/).describe('The loginId alexa_begin_login returned.'),
        redirectUrl: z
          .string()
          .min(12)
          .max(4096)
          .describe('The full address of the www.amazon.com/ap/maplanding page after signing in (or its authorization code).'),
      }),
    },
    async ({ loginId, redirectUrl }) => {
      const registration = await client.browserLogin().finish(loginId, redirectUrl);
      await client.adoptRegistration(registration);
      const devices = await client.listDevices();
      return minifiedResult({ ok: true, amazonPage: registration.amazonPage, devices: devices.length });
    },
  );
}
