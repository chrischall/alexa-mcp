import type { McpServer } from '@modelcontextprotocol/server';
import { UNTRUSTED_DESCRIPTION_SUFFIX, toolAnnotations, untrustedResult } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { AlexaClient } from '../client.js';
import { compactNotification } from '../views.js';

export function registerNotificationTools(server: McpServer, client: AlexaClient): void {
  server.registerTool(
    'alexa_list_alarms_reminders',
    {
      description:
        'List the alarms, timers and reminders set on the account’s Alexa devices, with label, device, date/time, ' +
        'whether each is on, and its recurrence. Optionally filter by type. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({
        type: z.enum(['Alarm', 'Timer', 'Reminder']).optional().describe('Only this kind.'),
        includeOff: z.boolean().default(false).describe('Also return alarms/reminders that are switched off.'),
      }),
    },
    async ({ type, includeOff }) => {
      const [{ notifications = [] }, devices] = await Promise.all([client.listNotifications(), client.listDevices()]);
      const names = new Map(devices.map((d) => [d.serialNumber, d.accountName]));
      const rows = notifications
        .map(compactNotification)
        .filter((n) => (!type || n.type === type) && (includeOff || n.on))
        .map((n) => ({ ...n, device: (n.device && names.get(n.device)) ?? n.device }));
      return untrustedResult(rows);
    },
  );
}
