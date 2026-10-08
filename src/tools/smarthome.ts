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
import {
  type CapabilityState,
  SMART_HOME_ACTIONS,
  compactSmartHomeEntity,
  compactSmartHomeState,
  parseCapabilityStates,
  temperatureValue,
} from '../views.js';
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

export type Entity = ReturnType<typeof compactSmartHomeEntity>;
export interface EntityState {
  entity: Entity;
  states: CapabilityState[] | null;
  error: string | null;
}

/**
 * Read live state for smart-home entities. `querySmarthomeDevices` wants
 * APPLIANCE ids, so map each entity id through `getSmarthomeDevicesV2`'s
 * `legacyAppliance { applianceId, entityId }`. Entities with no appliance
 * (scenes, groups) report an error row, as do per-entity `errors` such as
 * ENDPOINT_UNREACHABLE — neither fails the call.
 */
export async function readStates(client: AlexaClient, entities: Entity[]): Promise<EntityState[]> {
  if (entities.length === 0) return [];
  const endpoints = await client.listSmartHomeEndpoints();
  const applianceOf = new Map<string, string>();
  for (const ep of endpoints) {
    const legacy = (ep.legacyAppliance ?? {}) as Record<string, unknown>;
    if (typeof legacy.entityId === 'string' && typeof legacy.applianceId === 'string') applianceOf.set(legacy.entityId, legacy.applianceId);
  }
  const ids = [...new Set(entities.map((e) => applianceOf.get(e.id)).filter((id): id is string => id !== undefined))];
  const body = ids.length > 0 ? await client.querySmartHomeState(ids) : {};
  const states = new Map<string, CapabilityState[]>();
  for (const ds of body.deviceStates ?? []) {
    const id = ((ds.entity ?? {}) as Record<string, unknown>).entityId;
    if (typeof id === 'string') states.set(id, parseCapabilityStates(ds.capabilityStates));
  }
  const errors = new Map<string, string>();
  for (const err of body.errors ?? []) {
    const id = ((err.entity ?? {}) as Record<string, unknown>).entityId;
    if (typeof id === 'string') errors.set(id, String(err.code ?? err.message ?? 'UNKNOWN'));
  }
  return entities.map((entity) => {
    const applianceId = applianceOf.get(entity.id);
    if (!applianceId) return { entity, states: null, error: 'No state available for this entity (scenes and groups have none).' };
    const error = errors.get(applianceId) ?? null;
    return { entity, states: states.get(applianceId) ?? (error ? null : []), error };
  });
}

/** `allowedTemperatureRange` bounds may be numbers or `{ value, scale }`. */
export function bounds(range: unknown): { min: number; max: number } | undefined {
  if (!range || typeof range !== 'object') return undefined;
  const r = range as Record<string, unknown>;
  const min = temperatureValue(r.minimum);
  const max = temperatureValue(r.maximum);
  return min !== undefined && max !== undefined ? { min, max } : undefined;
}

const THERMOSTAT_MODES = ['HEAT', 'COOL', 'AUTO', 'OFF', 'ECO'] as const;

export type TempScale = 'fahrenheit' | 'celsius';
export interface Range {
  min: number;
  max: number;
}

/** What a thermostat's state says about its setpoints, scale and allowed ranges (in its own scale). */
export function thermostatContext(states: CapabilityState[]) {
  const current = compactSmartHomeState(states);
  const ownScale: TempScale = String(current.scale ?? 'FAHRENHEIT').toLowerCase() === 'celsius' ? 'celsius' : 'fahrenheit';
  const range = states.find((s) => s.name === 'allowedTemperatureRange')?.value as Record<string, unknown> | undefined;
  const heat = bounds(range?.heating);
  const cool = bounds(range?.cooling);
  const present = [heat, cool].filter((b): b is Range => !!b);
  const union = present.length ? { min: Math.min(...present.map((b) => b.min)), max: Math.max(...present.map((b) => b.max)) } : undefined;
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  return {
    mode: typeof current.thermostatMode === 'string' ? current.thermostatMode : undefined,
    lower: num(current.lowerSetpoint),
    upper: num(current.upperSetpoint),
    target: num(current.targetSetpoint),
    ownScale,
    heat: heat ?? union,
    cool: cool ?? union,
    union,
  };
}

/** The verified dual-setpoint (AUTO) form — always both bounds. */
export const dualSetpoint = (lower: number, upper: number, scale: TempScale) => ({
  action: 'setTargetTemperature',
  'upperSetTemperature.value': upper,
  'upperSetTemperature.scale': scale,
  'lowerSetTemperature.value': lower,
  'lowerSetTemperature.scale': scale,
});
/** The single-setpoint (HEAT / COOL) form — not live-verified. */
export const singleSetpoint = (value: number, scale: TempScale) => ({
  action: 'setTargetTemperature',
  'targetTemperature.value': value,
  'targetTemperature.scale': scale,
});
export const modeCommand = (mode: string) => ({ action: 'setThermostatMode', 'thermostatMode.value': mode });

export function registerSmartHomeTools(server: McpServer, client: AlexaClient): void {
  server.registerTool(
    'alexa_list_smart_home',
    {
      description:
        'List the smart-home devices, groups and scenes Alexa controls — thermostats, lights, plugs, switches, locks, ' +
        'sensors, scenes — with the actions this server can perform on each (setTemperature / setThermostatMode via ' +
        'alexa_set_thermostat; the rest via alexa_control_smart_home). These are NOT in alexa_list_devices, which ' +
        'only lists Echo speakers, Echo Shows and Fire TVs. Optionally filter by kind (e.g. THERMOSTAT, LIGHT, ' +
        'SMARTPLUG, SCENE_TRIGGER).',
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
        'Control an Alexa smart-home device, group or scene: turn lights and plugs on or off, set brightness ' +
        '(0–100), set a light colour (colorName, e.g. "red") or white temperature (colorTemperatureName, e.g. ' +
        '"warm_white"), activate a scene, or lock a smart lock. Unlocking is deliberately not offered, nor are ' +
        'garage doors. Thermostats use alexa_set_thermostat. A device that is offline is reported as an error, not ' +
        'silently ignored.' +
        WRITE_SUFFIX,
      // Locking has no inverse here (unlock is never offered), so the tool as a whole is destructive.
      annotations: toolAnnotations({ readOnly: false, destructive: true }),
      inputSchema: z.object({
        target: z.string().min(1).describe('Device, group or scene name (or id) from alexa_list_smart_home.'),
        action: z.enum(SMART_HOME_ACTIONS).describe('What to do.'),
        brightness: z.number().int().min(0).max(100).optional().describe('Required for setBrightness: 0–100.'),
        colorName: z
          .string()
          .regex(/^[a-z_]{2,40}$/)
          .optional()
          .describe('Required for setColor: an Alexa colour name, lower case, e.g. "red", "blue", "warm_white".'),
        colorTemperatureName: z
          .string()
          .regex(/^[a-z_]{2,40}$/)
          .optional()
          .describe('Required for setColorTemperature: e.g. "warm_white", "soft_white", "white", "daylight_white", "cool_white".'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ target, action, brightness, colorName, colorTemperatureName, confirmToken }, ctx) => {
      const entity = findEntity(await client.listSmartHomeEntities(), target);
      if (!entity.actions.includes(action)) {
        throw new McpToolError(`${entity.name} does not support ${action}.`, {
          hint: `It supports: ${entity.actions.join(', ') || 'none of the actions this server can send'}.`,
        });
      }
      let parameters: Record<string, unknown>;
      let detail = '';
      switch (action) {
        case 'setBrightness':
          if (brightness === undefined) throw new McpToolError('setBrightness needs a brightness (0–100).');
          parameters = { action, brightness };
          detail = ` ${brightness}%`;
          break;
        case 'setColor':
          if (!colorName) throw new McpToolError('setColor needs a colorName, e.g. "red".');
          parameters = { action, colorName };
          detail = ` ${colorName}`;
          break;
        case 'setColorTemperature':
          if (!colorTemperatureName) throw new McpToolError('setColorTemperature needs a colorTemperatureName, e.g. "warm_white".');
          parameters = { action, colorTemperatureName };
          detail = ` ${colorTemperatureName}`;
          break;
        case 'lock':
          parameters = { action: 'lockAction', 'targetLockState.value': 'LOCKED' };
          break;
        default:
          parameters = { action };
      }
      const gate = await confirmWrite(ctx, {
        tool: 'alexa_control_smart_home',
        action: `alexa.smart_home.${action}`,
        summary: `${action}${detail} → ${entity.name}`,
        account: undefined,
        target: entity.id,
        payload: { entityId: entity.id, entityType: entity.entityType, parameters },
        confirmToken,
      });
      if (gate) return gate;
      await client.controlSmartHome(entity.id, parameters, entity.entityType as 'APPLIANCE' | 'GROUP');
      return minifiedResult({ ok: true, target: entity.name, action, ...(detail ? { value: detail.trim() } : {}) });
    },
  );

  server.registerTool(
    'alexa_get_smart_home_state',
    {
      description:
        'Read the live state of Alexa smart-home devices: what temperature a thermostat reads and is set to ' +
        '(mode, heat/cool setpoints, humidity, whether heating or cooling is running), whether lights and plugs ' +
        'are on and how bright, light colour, lock state, contact and motion sensors, and whether each device is ' +
        'reachable. Name the devices, or pass a kind (e.g. THERMOSTAT, LIGHT) to read every one of that kind. An ' +
        'unreachable device is reported on its row, not as a failure.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({
        targets: z
          .array(z.string().min(1))
          .min(1)
          .max(50)
          .optional()
          .describe('Device names (or ids) from alexa_list_smart_home.'),
        kind: z.string().optional().describe('Read every entity of this kind instead, e.g. THERMOSTAT, LIGHT (case-insensitive).'),
        view: viewParam(VIEWS),
      }),
    },
    async ({ targets, kind, view }) => {
      if (!targets && !kind) {
        throw new McpToolError('Name the devices (targets) or pass a kind.', { hint: 'alexa_list_smart_home lists them.' });
      }
      const all = await client.listSmartHomeEntities();
      const wanted = kind?.toUpperCase();
      const chosen = targets
        ? targets.map((t) => findEntity(all, t))
        : all.map(compactSmartHomeEntity).filter((e) => e.kind?.toUpperCase() === wanted).slice(0, 50);
      const unique = [...new Map(chosen.map((e) => [e.id, e])).values()];
      const rows = await readStates(client, unique);
      const v = resolveView(view, VIEWS);
      return viewResult(
        v,
        rows.map(({ entity, states, error }) => ({
          name: entity.name,
          id: entity.id,
          kind: entity.kind,
          ...(states ? (v === 'full' ? { capabilityStates: states } : { state: compactSmartHomeState(states) }) : {}),
          ...(error ? { error } : {}),
        })),
      );
    },
  );

  server.registerTool(
    'alexa_set_thermostat',
    {
      description:
        'Set an Alexa-connected thermostat: change the temperature setpoint (heat-to / cool-to) and/or the mode ' +
        '(HEAT, COOL, AUTO, OFF, ECO). In AUTO mode pass lower (heat to) and/or upper (cool to) — the one you omit ' +
        'is kept from the current setting; in HEAT or COOL mode pass temperature. Reads the thermostat first and ' +
        'refuses a setpoint outside its allowed range. Units default to the thermostat’s own scale.' +
        WRITE_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: false, idempotent: true }),
      inputSchema: z.object({
        target: z.string().min(1).describe('Thermostat name (or id) from alexa_list_smart_home.'),
        temperature: z.number().min(-50).max(120).optional().describe('Single setpoint for HEAT or COOL mode.'),
        lower: z.number().min(-50).max(120).optional().describe('AUTO mode: heat-to setpoint (lower bound).'),
        upper: z.number().min(-50).max(120).optional().describe('AUTO mode: cool-to setpoint (upper bound).'),
        mode: z.enum(THERMOSTAT_MODES).optional().describe('New thermostat mode.'),
        scale: z.enum(['fahrenheit', 'celsius']).optional().describe('Units of the temperatures given. Defaults to the thermostat’s scale.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ target, temperature, lower, upper, mode, scale, confirmToken }, ctx) => {
      const entity = findEntity(await client.listSmartHomeEntities(), target);
      const settingTemp = temperature !== undefined || lower !== undefined || upper !== undefined;
      if (!settingTemp && !mode) {
        throw new McpToolError('Nothing to change: pass temperature, lower/upper, or mode.');
      }
      const canSet = entity.actions.includes('setTemperature');
      const canMode = entity.actions.includes('setThermostatMode');
      if (!canSet && !canMode) {
        throw new McpToolError(`${entity.name} is not a thermostat this server can control.`, {
          hint: 'alexa_list_smart_home kind THERMOSTAT lists thermostats.',
        });
      }
      if (settingTemp && !canSet) throw new McpToolError(`${entity.name} does not accept a temperature setpoint.`);
      if (mode && !canMode) throw new McpToolError(`${entity.name} does not accept a mode change.`);

      const [read] = await readStates(client, [entity]);
      if (read.error || !read.states) {
        throw new McpToolError(`Could not read ${entity.name}'s current settings: ${read.error ?? 'no state'}.`, {
          hint: 'ENDPOINT_UNREACHABLE means the thermostat is offline.',
        });
      }
      const t = thermostatContext(read.states);
      const ownScale = t.ownScale;
      const unit = scale ?? ownScale;
      // Thermostat scale → request scale.
      const convert = (n: number) =>
        unit === ownScale ? n : unit === 'celsius' ? Math.round((((n - 32) * 5) / 9) * 10) / 10 : Math.round(((n * 9) / 5 + 32) * 10) / 10;
      const effectiveMode = mode ?? t.mode;

      const commands: Record<string, unknown>[] = [];
      if (mode) commands.push(modeCommand(mode));

      let summary = mode ? `mode ${mode}` : '';
      if (settingTemp) {
        if (effectiveMode === 'OFF') throw new McpToolError('The thermostat is (or would be) OFF; a setpoint needs HEAT, COOL or AUTO.');
        const check = (label: string, value: number, b: Range | undefined) => {
          if (!b) return;
          const lo = convert(b.min);
          const hi = convert(b.max);
          const [min, max] = lo <= hi ? [lo, hi] : [hi, lo];
          if (value < min || value > max) {
            throw new McpToolError(`${label} ${value}° is outside ${entity.name}'s allowed range ${min}–${max}° (${unit}).`);
          }
        };
        const keep = mode === undefined || mode === t.mode;
        const dual = effectiveMode === 'AUTO' || (effectiveMode === undefined && t.lower !== undefined && t.upper !== undefined);
        if (dual) {
          if (temperature !== undefined) {
            throw new McpToolError(`${entity.name} is in AUTO mode, which has two setpoints.`, {
              hint: 'Pass lower (heat to) and/or upper (cool to) instead of temperature.',
            });
          }
          const lo = lower ?? (keep && t.lower !== undefined ? convert(t.lower) : undefined);
          const hi = upper ?? (keep && t.upper !== undefined ? convert(t.upper) : undefined);
          if (lo === undefined || hi === undefined) {
            throw new McpToolError('AUTO mode needs both lower and upper setpoints, and the current ones are not known.', {
              hint: 'Pass both lower and upper.',
            });
          }
          if (lo >= hi) throw new McpToolError(`The lower setpoint (${lo}°) must be below the upper one (${hi}°).`);
          check('Lower setpoint', lo, t.heat);
          check('Upper setpoint', hi, t.cool);
          commands.push(dualSetpoint(lo, hi, unit));
          summary += `${summary ? ', ' : ''}heat to ${lo}° / cool to ${hi}° ${unit}`;
        } else {
          if (temperature === undefined) {
            throw new McpToolError(`${entity.name} is in ${effectiveMode ?? 'a single-setpoint'} mode; pass temperature, not lower/upper.`);
          }
          check('Temperature', temperature, effectiveMode === 'HEAT' ? t.heat : effectiveMode === 'COOL' ? t.cool : t.union);
          commands.push(singleSetpoint(temperature, unit));
          summary += `${summary ? ', ' : ''}set to ${temperature}° ${unit}`;
        }
      }

      const gate = await confirmWrite(ctx, {
        tool: 'alexa_set_thermostat',
        action: 'alexa.set_thermostat',
        summary: `${entity.name}: ${summary}`,
        account: undefined,
        target: entity.id,
        payload: { entityId: entity.id, commands },
        confirmToken,
      });
      if (gate) return gate;
      for (const parameters of commands) await client.controlSmartHome(entity.id, parameters, 'APPLIANCE');
      return minifiedResult({ ok: true, target: entity.name, sent: commands });
    },
  );
}
