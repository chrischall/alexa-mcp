import type { McpServer } from '@modelcontextprotocol/server';
import {
  McpToolError,
  confirmTokenParam,
  confirmWrite,
  minifiedResult,
  resolveView,
  toolAnnotations,
  viewParam,
  viewResult,
} from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { AlexaClient } from '../client.js';
import { SMART_HOME_ACTIONS, compactSmartHomeEntity } from '../views.js';
import { WRITE_SUFFIX } from './common.js';

const VIEWS = ['compact', 'full'] as const;

export function findEntity(entities: Record<string, unknown>[], query: string) {
  const q = query.trim().toLowerCase();
  const all = entities.map(compactSmartHomeEntity);
  const byId = all.find((e) => e.id.toLowerCase() === q);
  if (byId) return byId;
  const exact = all.filter((e) => e.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const partial = all.filter((e) => e.name.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new McpToolError(`"${query}" matches more than one smart-home device: ${partial.map((e) => e.name).join(', ')}.`, {
      hint: 'Use the exact name or the id from alexa_list_smart_home.',
    });
  }
  throw new McpToolError(`No smart-home device, group or scene matches "${query}".`, {
    hint: 'alexa_list_smart_home lists them all.',
  });
}

export function registerSmartHomeTools(server: McpServer, client: AlexaClient): void {
  server.registerTool(
    'alexa_list_smart_home',
    {
      description:
        'List the smart-home devices, groups and scenes Alexa controls — lights, plugs, thermostats, scenes — with ' +
        'the actions alexa_control_smart_home can perform on each. Optionally filter by kind (e.g. LIGHT, SCENE_TRIGGER).',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({
        kind: z.string().optional().describe('Only entities of this kind, e.g. LIGHT, THERMOSTAT, SCENE_TRIGGER (case-insensitive).'),
        view: viewParam(VIEWS),
      }),
    },
    async ({ kind, view }) => {
      const entities = await client.listSmartHomeEntities();
      const wanted = kind?.toUpperCase();
      const keep = entities.filter((e) => !wanted || compactSmartHomeEntity(e).kind?.toUpperCase() === wanted);
      const v = resolveView(view, VIEWS);
      return viewResult(v, v === 'full' ? keep : keep.map(compactSmartHomeEntity));
    },
  );

  server.registerTool(
    'alexa_control_smart_home',
    {
      description:
        'Control an Alexa smart-home device, group or scene: turnOn, turnOff, setBrightness (lights, 0–100) or ' +
        'sceneActivate. Locks, garage doors and thermostats are not supported. A device that is offline is reported ' +
        'as an error, not silently ignored.' +
        WRITE_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: false }),
      inputSchema: z.object({
        target: z.string().min(1).describe('Device, group or scene name (or id) from alexa_list_smart_home.'),
        action: z.enum(SMART_HOME_ACTIONS).describe('What to do.'),
        brightness: z.number().int().min(0).max(100).optional().describe('Required for setBrightness: 0–100.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ target, action, brightness, confirmToken }, ctx) => {
      const entity = findEntity(await client.listSmartHomeEntities(), target);
      if (!entity.actions.includes(action)) {
        throw new McpToolError(`${entity.name} does not support ${action}.`, {
          hint: `It supports: ${entity.actions.join(', ') || 'none of the actions this server can send'}.`,
        });
      }
      if (action === 'setBrightness' && brightness === undefined) {
        throw new McpToolError('setBrightness needs a brightness (0–100).');
      }
      const parameters: Record<string, unknown> =
        action === 'setBrightness' ? { action, brightness } : { action };
      const gate = await confirmWrite(ctx, {
        tool: 'alexa_control_smart_home',
        action: `alexa.smart_home.${action}`,
        summary: `${action}${brightness !== undefined && action === 'setBrightness' ? ` ${brightness}%` : ''} → ${entity.name}`,
        account: undefined,
        target: entity.id,
        payload: { entityId: entity.id, entityType: entity.entityType, parameters },
        confirmToken,
      });
      if (gate) return gate;
      await client.controlSmartHome(entity.id, parameters, entity.entityType as 'APPLIANCE' | 'GROUP');
      return minifiedResult({ ok: true, target: entity.name, action, ...(brightness !== undefined ? { brightness } : {}) });
    },
  );
}
