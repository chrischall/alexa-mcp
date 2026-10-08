import type { McpServer } from '@modelcontextprotocol/server';
import {
  McpToolError,
  UNTRUSTED_DESCRIPTION_SUFFIX,
  confirmTokenParam,
  confirmWrite,
  minifiedResult,
  toolAnnotations,
  untrustedResult,
} from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { AlexaClient } from '../client.js';
import type { RawDevice } from '../remote.js';
import { compactBluetooth } from '../views.js';
import { WRITE_SUFFIX, deviceArg } from './common.js';

/** Equalizer bands, in dB. Alexa's own app offers −6 to +6. */
const band = z.number().int().min(-6).max(6);

function requireEqualizer(dev: RawDevice): void {
  if (!(dev.capabilities ?? []).some((c) => c.startsWith('EQUALIZER_CONTROLLER'))) {
    throw new McpToolError(`${dev.accountName ?? dev.serialNumber} has no equalizer (bass/mid/treble) control.`, {
      hint: 'Echo speakers and soundbars usually do; Fire TVs, tablets and some Echo Shows do not.',
    });
  }
}

/** Do Not Disturb, equalizer and Bluetooth — per-device settings with their own inverse. */
export function registerSettingsTools(server: McpServer, client: AlexaClient): void {
  server.registerTool(
    'alexa_get_do_not_disturb',
    {
      description: 'Which Alexa devices have Do Not Disturb (DND, quiet mode) switched on right now.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({}),
    },
    async () => {
      const [{ doNotDisturbDeviceStatusList: list = [] }, devices] = await Promise.all([client.getDoNotDisturb(), client.listDevices()]);
      const names = new Map(devices.map((d) => [d.serialNumber, d.accountName]));
      return minifiedResult(
        list.map((d) => ({ name: names.get(String(d.deviceSerialNumber)) ?? null, serial: String(d.deviceSerialNumber), enabled: d.enabled === true })),
      );
    },
  );

  server.registerTool(
    'alexa_set_do_not_disturb',
    {
      description: 'Switch Do Not Disturb (DND, quiet mode) on or off for an Alexa device.' + WRITE_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: false, idempotent: true }),
      inputSchema: z.object({
        device: deviceArg,
        enabled: z.boolean().describe('true turns Do Not Disturb on, false turns it off.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ device, enabled, confirmToken }, ctx) => {
      const dev = await client.resolveDevice(device);
      const gate = await confirmWrite(ctx, {
        tool: 'alexa_set_do_not_disturb',
        action: 'alexa.set_do_not_disturb',
        summary: `Turn Do Not Disturb ${enabled ? 'on' : 'off'} on ${dev.accountName}`,
        account: undefined,
        target: dev.serialNumber,
        payload: { device: dev.serialNumber, enabled },
        confirmToken,
      });
      if (gate) return gate;
      await client.setDoNotDisturb(dev.serialNumber, enabled);
      return minifiedResult({ ok: true, device: dev.accountName, enabled });
    },
  );

  server.registerTool(
    'alexa_get_equalizer',
    {
      description: 'Read an Echo speaker or soundbar’s equalizer: bass, mid(range) and treble, in dB.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({ device: deviceArg }),
    },
    async ({ device }) => {
      const dev = await client.resolveDevice(device);
      requireEqualizer(dev);
      const eq = await client.getEqualizer(dev.serialNumber);
      return minifiedResult({ device: dev.accountName, bass: eq.bass ?? null, mid: eq.mid ?? null, treble: eq.treble ?? null });
    },
  );

  server.registerTool(
    'alexa_set_equalizer',
    {
      description:
        'Set an Echo speaker or soundbar’s equalizer — bass, mid and/or treble, −6 to +6 dB. Bands you leave out ' +
        'keep their current value.' +
        WRITE_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: false, idempotent: true }),
      inputSchema: z.object({
        device: deviceArg,
        bass: band.optional().describe('Bass, −6 to +6.'),
        mid: band.optional().describe('Midrange, −6 to +6.'),
        treble: band.optional().describe('Treble, −6 to +6.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ device, bass, mid, treble, confirmToken }, ctx) => {
      if (bass === undefined && mid === undefined && treble === undefined) {
        throw new McpToolError('Pass at least one of bass, mid, treble.');
      }
      const dev = await client.resolveDevice(device);
      requireEqualizer(dev);
      const cur = await client.getEqualizer(dev.serialNumber);
      const next = { bass: bass ?? cur.bass ?? 0, mid: mid ?? cur.mid ?? 0, treble: treble ?? cur.treble ?? 0 };
      const gate = await confirmWrite(ctx, {
        tool: 'alexa_set_equalizer',
        action: 'alexa.set_equalizer',
        summary: `Set ${dev.accountName} equalizer to bass ${next.bass}, mid ${next.mid}, treble ${next.treble}`,
        account: undefined,
        target: dev.serialNumber,
        payload: { device: dev.serialNumber, ...next },
        confirmToken,
      });
      if (gate) return gate;
      await client.setEqualizer(dev.serialNumber, next.bass, next.mid, next.treble);
      return minifiedResult({ ok: true, device: dev.accountName, ...next });
    },
  );

  server.registerTool(
    'alexa_list_bluetooth',
    {
      description:
        'List the Bluetooth phones, speakers and headphones paired with each Alexa device, which are connected, and ' +
        'whether the Echo is streaming over Bluetooth. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({}),
    },
    async () => {
      const [{ bluetoothStates = [] }, devices] = await Promise.all([client.getBluetooth(), client.listDevices()]);
      const names = new Map(devices.map((d) => [d.serialNumber, d.accountName]));
      return untrustedResult(
        bluetoothStates.map((b) => {
          const row = compactBluetooth(b);
          return { device: names.get(row.serial) ?? (typeof b.friendlyName === 'string' ? b.friendlyName : null), ...row };
        }),
      );
    },
  );
}
