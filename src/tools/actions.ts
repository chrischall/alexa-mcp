import type { McpServer } from '@modelcontextprotocol/server';
import { McpToolError, confirmTokenParam, confirmWrite, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { AlexaClient, ValuelessSequenceCommand } from '../client.js';
import { WRITE_SUFFIX, defaultDevice, deviceArg } from './common.js';

/**
 * Alexa's built-in spoken features. `textCommand` (free-text "Alexa, …") is
 * deliberately absent: it can make purchases and unlock doors.
 */
const BUILTINS = [
  'weather',
  'traffic',
  'flashbriefing',
  'goodmorning',
  'funfact',
  'joke',
  'cleanup',
  'singasong',
  'tellstory',
  'calendarToday',
  'calendarTomorrow',
  'calendarNext',
] as const satisfies readonly ValuelessSequenceCommand[];

const FIRE_TV = {
  turnOn: 'fireTVTurnOn',
  turnOff: 'fireTVTurnOff',
  pause: 'fireTVPauseVideo',
  resume: 'fireTVResumeVideo',
  home: 'fireTVNavigateHome',
} as const satisfies Record<string, ValuelessSequenceCommand>;

/** Audible or visible in the room, so all destructive: nothing here can be taken back. */
export function registerActionTools(server: McpServer, client: AlexaClient): void {
  server.registerTool(
    'alexa_run_builtin',
    {
      description:
        'Have an Echo play one of Alexa’s built-in features out loud: the weather forecast, traffic, the flash ' +
        'briefing (news), the good-morning greeting, a fun fact, a joke, sing a song, tell a story, today’s / ' +
        'tomorrow’s / the next calendar event, or "cleanup" (tidy-up music). Everyone in the room hears it.' +
        WRITE_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: true, openWorld: true }),
      inputSchema: z.object({
        device: deviceArg,
        command: z.enum(BUILTINS).describe('Which built-in feature.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ device, command, confirmToken }, ctx) => {
      const dev = await client.resolveDevice(device);
      const gate = await confirmWrite(ctx, {
        tool: 'alexa_run_builtin',
        action: `alexa.builtin.${command}`,
        summary: `Play "${command}" out loud on ${dev.accountName}`,
        account: undefined,
        target: dev.serialNumber,
        payload: { device: dev.serialNumber, command },
        confirmToken,
      });
      if (gate) return gate;
      await client.sequence(dev.serialNumber, command);
      return minifiedResult({ ok: true, device: dev.accountName, command });
    },
  );

  server.registerTool(
    'alexa_fire_tv',
    {
      description:
        'Control a Fire TV through Alexa: turn the TV on or off, pause or resume the video, or go to the home ' +
        'screen.' +
        WRITE_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: true, openWorld: true }),
      inputSchema: z.object({
        device: deviceArg,
        command: z.enum(['turnOn', 'turnOff', 'pause', 'resume', 'home']).describe('What to do.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ device, command, confirmToken }, ctx) => {
      const dev = await client.resolveDevice(device);
      if (dev.deviceFamily !== 'FIRE_TV') {
        throw new McpToolError(`${dev.accountName} is not a Fire TV.`, { hint: 'alexa_list_devices shows each device’s family.' });
      }
      const gate = await confirmWrite(ctx, {
        tool: 'alexa_fire_tv',
        action: `alexa.fire_tv.${command}`,
        summary: `${command} on ${dev.accountName}`,
        account: undefined,
        target: dev.serialNumber,
        payload: { device: dev.serialNumber, command },
        confirmToken,
      });
      if (gate) return gate;
      await client.sequence(dev.serialNumber, FIRE_TV[command]);
      return minifiedResult({ ok: true, device: dev.accountName, command });
    },
  );

  server.registerTool(
    'alexa_stop',
    {
      description:
        'Stop whatever an Alexa device is doing — music, a ringing alarm or timer, speech — like saying "Alexa, ' +
        'stop". Pass a device, or allDevices to stop every device on the account.' +
        WRITE_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: true, openWorld: true }),
      inputSchema: z.object({
        device: deviceArg.optional(),
        allDevices: z.boolean().optional().describe('Stop every Alexa device on the account.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ device, allDevices, confirmToken }, ctx) => {
      if (!!device === !!allDevices) {
        throw new McpToolError('Pass exactly one of device or allDevices.');
      }
      const dev = device ? await client.resolveDevice(device) : await defaultDevice(client);
      const gate = await confirmWrite(ctx, {
        tool: 'alexa_stop',
        action: allDevices ? 'alexa.stop_all' : 'alexa.stop',
        summary: allDevices ? 'Stop every Alexa device' : `Stop ${dev.accountName}`,
        account: undefined,
        target: allDevices ? 'ALL' : dev.serialNumber,
        payload: allDevices ? { all: true } : { device: dev.serialNumber },
        confirmToken,
      });
      if (gate) return gate;
      await client.sequence(dev.serialNumber, allDevices ? 'deviceStopAll' : 'deviceStop');
      return minifiedResult({ ok: true, stopped: allDevices ? 'all devices' : dev.accountName });
    },
  );
}
