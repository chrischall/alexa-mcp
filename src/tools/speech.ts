import type { McpServer } from '@modelcontextprotocol/server';
import { McpToolError, confirmTokenParam, confirmWrite, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { AlexaClient } from '../client.js';
import { WRITE_SUFFIX, deviceArg } from './common.js';

/** Alexa truncates or rejects long TTS; this is the documented sequence-command ceiling. */
export const MAX_SPEECH_CHARS = 250;

export function registerSpeechTools(server: McpServer, client: AlexaClient): void {
  server.registerTool(
    'alexa_speak',
    {
      description:
        'Make Alexa say something out loud. mode "speak" speaks the text on ONE device in Alexa’s voice; mode ' +
        '"announce" plays it as an announcement (chime first) on one or more devices at once. Everyone in the ' +
        'room hears it, so it cannot be taken back.' +
        WRITE_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: true }),
      inputSchema: z.object({
        devices: z
          .array(deviceArg)
          .min(1)
          .describe('Device(s) to speak on. "speak" mode takes exactly one; "announce" takes one or more.'),
        text: z.string().min(1).max(MAX_SPEECH_CHARS).describe(`What to say (up to ${MAX_SPEECH_CHARS} characters).`),
        mode: z.enum(['speak', 'announce']).default('speak').describe('"speak" (default) or "announce".'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ devices, text, mode, confirmToken }, ctx) => {
      if (mode === 'speak' && devices.length !== 1) {
        throw new McpToolError('"speak" mode speaks on exactly one device.', {
          hint: 'Use mode "announce" to reach several devices at once.',
        });
      }
      const resolved = await Promise.all(devices.map((d) => client.resolveDevice(d)));
      const serials = [...new Set(resolved.map((d) => d.serialNumber))];
      const gate = await confirmWrite(ctx, {
        tool: 'alexa_speak',
        action: `alexa.${mode}`,
        summary: `${mode === 'speak' ? 'Speak' : 'Announce'} on ${resolved.map((d) => d.accountName).join(', ')}`,
        account: undefined,
        target: serials.join(','),
        payload: { mode, devices: serials, text },
        confirmToken,
      });
      if (gate) return gate;
      if (mode === 'speak') await client.speak(serials[0], text, 'speak');
      else await client.announce(serials, text);
      return minifiedResult({ ok: true, mode, devices: resolved.map((d) => d.accountName) });
    },
  );
}
