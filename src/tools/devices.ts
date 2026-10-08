import type { McpServer } from '@modelcontextprotocol/server';
import {
  confirmTokenParam,
  confirmWrite,
  minifiedResult,
  resolveView,
  toolAnnotations,
  viewParam,
  viewResult,
} from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { AlexaClient, PlaybackCommand } from '../client.js';
import { compactDevice, compactVolume } from '../views.js';
import { WRITE_SUFFIX, deviceArg } from './common.js';

const VIEWS = ['compact', 'full'] as const;

export function registerDeviceTools(server: McpServer, client: AlexaClient): void {
  server.registerTool(
    'alexa_list_devices',
    {
      description:
        'List the Echo speakers, Echo Shows, Fire TVs and other Alexa devices on the Amazon account, with name, serial, ' +
        'device family and whether each is online. Use the name or serial with the other alexa_ tools. Thermostats, ' +
        'lights, plugs, switches, locks and other smart-home devices are NOT here: use alexa_list_smart_home for those.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({ view: viewParam(VIEWS) }),
    },
    async ({ view }) => {
      const devices = await client.listDevices();
      const v = resolveView(view, VIEWS);
      return viewResult(v, v === 'full' ? devices : devices.map(compactDevice));
    },
  );

  server.registerTool(
    'alexa_get_now_playing',
    {
      description: 'What is playing on an Alexa device right now — media state, title, artist and provider, from its player.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({ device: deviceArg }),
    },
    async ({ device }) => {
      const dev = await client.resolveDevice(device);
      const body = (await client.getPlayerInfo(dev.serialNumber)) as { playerInfo?: Record<string, unknown> } | null;
      const info = body?.playerInfo;
      if (!info) return minifiedResult({ device: dev.accountName, state: null });
      const text = (info.infoText ?? {}) as Record<string, unknown>;
      const provider = (info.provider ?? {}) as Record<string, unknown>;
      const volume = (info.volume ?? {}) as Record<string, unknown>;
      return minifiedResult({
        device: dev.accountName,
        state: info.state ?? null,
        title: text.title ?? null,
        artist: text.subText1 ?? null,
        album: text.subText2 ?? null,
        provider: provider.providerName ?? null,
        volume: volume.volume ?? null,
        muted: volume.muted ?? null,
      });
    },
  );

  server.registerTool(
    'alexa_list_volumes',
    {
      description: 'Current speaker volume (0–100) and mute state of every Alexa device that reports one.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({}),
    },
    async () => {
      const [{ volumes = [] }, devices] = await Promise.all([client.getAllDeviceVolumes(), client.listDevices()]);
      const names = new Map(devices.map((d) => [d.serialNumber, d.accountName]));
      return minifiedResult(
        (volumes as Record<string, unknown>[]).map((v) => ({ name: names.get(String(v.dsn)) ?? null, ...compactVolume(v) })),
      );
    },
  );

  server.registerTool(
    'alexa_set_volume',
    {
      description: 'Set the speaker volume (0–100) of an Alexa device.' + WRITE_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: false, idempotent: true }),
      inputSchema: z.object({
        device: deviceArg,
        volume: z.number().int().min(0).max(100).describe('Volume level, 0–100.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ device, volume, confirmToken }, ctx) => {
      const dev = await client.resolveDevice(device);
      const gate = await confirmWrite(ctx, {
        tool: 'alexa_set_volume',
        action: 'alexa.set_volume',
        summary: `Set ${dev.accountName} volume to ${volume}`,
        account: undefined,
        target: dev.serialNumber,
        payload: { device: dev.serialNumber, volume },
        confirmToken,
      });
      if (gate) return gate;
      await client.setVolume(dev.serialNumber, volume);
      return minifiedResult({ ok: true, device: dev.accountName, volume });
    },
  );

  server.registerTool(
    'alexa_playback',
    {
      description: 'Play, pause, skip to next or go back to previous on an Alexa device’s current media.' + WRITE_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: false }),
      inputSchema: z.object({
        device: deviceArg,
        command: z.enum(['play', 'pause', 'next', 'previous']).describe('The media command.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ device, command, confirmToken }, ctx) => {
      const dev = await client.resolveDevice(device);
      const gate = await confirmWrite(ctx, {
        tool: 'alexa_playback',
        action: 'alexa.playback',
        summary: `${command} on ${dev.accountName}`,
        account: undefined,
        target: dev.serialNumber,
        payload: { device: dev.serialNumber, command },
        confirmToken,
      });
      if (gate) return gate;
      await client.playback(dev.serialNumber, command as PlaybackCommand);
      return minifiedResult({ ok: true, device: dev.accountName, command });
    },
  );
}
