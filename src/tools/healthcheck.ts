import type { McpServer } from '@modelcontextprotocol/server';
import { registerCredentialHealthcheckTool } from '@chrischall/mcp-utils/healthcheck';
import type { AlexaClient } from '../client.js';
import { LOGIN_HINT } from '../registration.js';

/**
 * `alexa_healthcheck` — does Amazon still accept this session?
 *
 * The probe is `getDevices`, the cheapest authenticated read. Reaching it goes
 * through the same lazy init (and, if the cookie is stale, refresh) the real
 * tools use, so a pass means the whole path works, not just that a file exists.
 */
export function registerHealthcheckTools(server: McpServer, client: AlexaClient): void {
  registerCredentialHealthcheckTool({
    server,
    prefix: 'alexa',
    hostLabel: 'alexa.amazon.com',
    probePath: 'api/devices-v2/device',
    resolveCredential: async () => {
      const cfg = client.describeConfig();
      if (!cfg.configured) return { source: null };
      return { source: cfg.source, detail: { amazonPage: cfg.amazonPage, cookieAgeHours: cfg.cookieAgeHours } };
    },
    probeFn: () => client.listDevices(),
    hints: {
      no_credential: `No Alexa registration is configured. ${LOGIN_HINT}`,
      credential_rejected:
        'Amazon rejected the session. If a retry fails too, the registration was revoked (password change, or the ' +
        `virtual device removed under Amazon → Devices) — sign in again. ${LOGIN_HINT}`,
      ok: 'Amazon accepted the session and returned the device list.',
    },
  });
}
