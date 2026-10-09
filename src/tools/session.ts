import type { McpServer } from '@modelcontextprotocol/server';
import { minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { AlexaClient } from '../client.js';
import { LOGIN_HINT } from '../registration.js';

export function registerSessionTools(server: McpServer, client: AlexaClient): void {
  server.registerTool(
    'alexa_session_status',
    {
      description:
        'Report how this Alexa server is configured — whether a registration is present, where it came from, the ' +
        'Amazon site, and how old the session cookies are. Makes NO network call; alexa_healthcheck checks that ' +
        'Amazon still accepts the session.',
      annotations: toolAnnotations({ readOnly: true, openWorld: false }),
      inputSchema: z.object({}),
    },
    async () => {
      const cfg = client.describeConfig();
      return minifiedResult(cfg.configured ? cfg : { ...cfg, hint: LOGIN_HINT });
    },
  );
}
