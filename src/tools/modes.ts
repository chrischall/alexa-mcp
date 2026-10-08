import type { McpServer } from '@modelcontextprotocol/server';
import { McpToolError, confirmTokenParam, confirmWrite, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { AlexaClient } from '../client.js';
import { GARAGE_INSTANCE, isGarageDoor, modeInstances, parseCapabilityStates } from '../views.js';
import { WRITE_SUFFIX } from './common.js';
import { findEntity } from './smarthome.js';

type Rec = Record<string, unknown>;

interface ModeOption {
  value: string;
  name: string | null;
}
interface ModeController {
  instance: string;
  setting: string;
  options: ModeOption[];
  current: string | null;
  currentName: string | null;
}

/** `resources.friendlyNames[]` → the first `value.text`, else the first `value.assetId`. */
function friendlyName(resources: unknown): string | null {
  const list = ((resources ?? {}) as Rec).friendlyNames;
  if (!Array.isArray(list)) return null;
  const values = list.map((n) => ((n ?? {}) as Rec).value as Rec | undefined);
  const text = values.find((v) => typeof v?.text === 'string')?.text;
  const asset = values.find((v) => typeof v?.assetId === 'string')?.assetId;
  return (text ?? asset ?? null) as string | null;
}

/** The raw entity (for its supportedOperations) plus the endpoint (for names and values) of a target. */
async function resolve(client: AlexaClient, target: string) {
  const all = await client.listSmartHomeEntities();
  const entity = findEntity(all, target);
  const raw = all.find((e) => String(e.id) === entity.id) ?? {};
  const endpoint = (await client.listSmartHomeEndpoints()).find(
    (ep) => ((ep.legacyAppliance ?? {}) as Rec).entityId === entity.id,
  );
  const legacy = (endpoint?.legacyAppliance ?? {}) as Rec;
  return { entity, raw, legacy };
}

/**
 * Each mode controller the entity can be SET through (its `setModeValue@…_<instance>`
 * operations), named from `legacyAppliance.capabilities[]` (Alexa.ModeController,
 * same instance) when the endpoint declares them. Current values need a state
 * read and are filled only when `states` is given.
 */
function controllers(raw: Rec, legacy: Rec, states?: ReturnType<typeof parseCapabilityStates>): ModeController[] {
  const caps = Array.isArray(legacy.capabilities) ? (legacy.capabilities as Rec[]) : [];
  return modeInstances(raw).map((instance) => {
    const cap = caps.find((c) => c.interfaceName === 'Alexa.ModeController' && String(c.instance) === instance);
    const supported = (((cap?.configuration ?? {}) as Rec).supportedModes ?? []) as Rec[];
    const options = Array.isArray(supported)
      ? supported.map((m) => ({ value: String(m.value), name: friendlyName(m.modeResources) }))
      : [];
    const cur = states?.find((s) => s.namespace === 'Alexa.ModeController' && s.name === 'mode' && s.instance === instance)?.value;
    const current = cur === undefined || cur === null ? null : String(cur);
    return {
      instance,
      setting: friendlyName(cap?.resources) ?? instance,
      options,
      current,
      currentName: current === null ? null : (options.find((o) => o.value === current)?.name ?? null),
    };
  });
}

const describeOptions = (c: ModeController) =>
  c.options.length ? c.options.map((o) => (o.name ? `${o.name} (${o.value})` : o.value)).join(', ') : 'any value (none declared)';

/** Match an option by friendly name or value, case-insensitive. */
const matchOption = (c: ModeController, q: string) => {
  const w = q.trim().toLowerCase();
  return c.options.find((o) => o.value.toLowerCase() === w) ?? c.options.find((o) => (o.name ?? '').toLowerCase() === w);
};

/** The `setModeValue` shape verified live 2026-10-08 (Fan Mode). `setModeValue@…` actions answer FAILURE_TO_SEND. */
const setModeValue = (instance: string, mode: string) => ({ action: 'setModeValue', instance, mode });

export function registerModeTools(server: McpServer, client: AlexaClient): void {
  server.registerTool(
    'alexa_list_device_modes',
    {
      description:
        'List the mode settings of an Alexa smart-home device and what each is set to now, with the values it ' +
        'accepts: a thermostat’s fan mode (On / Auto / Circulate), a robot vacuum’s (Roomba) state, a light’s ' +
        'effect, washer or air-purifier modes. Use the setting and value names with alexa_set_device_mode.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({ target: z.string().min(1).describe('Device name (or id) from alexa_list_smart_home.') }),
    },
    async ({ target }) => {
      const { entity, raw, legacy } = await resolve(client, target);
      if (modeInstances(raw).length === 0) {
        throw new McpToolError(`${entity.name} has no mode settings.`, { hint: 'alexa_list_smart_home shows each device’s actions.' });
      }
      let states: ReturnType<typeof parseCapabilityStates> | undefined;
      if (typeof legacy.applianceId === 'string') {
        const body = await client.querySmartHomeState([legacy.applianceId]);
        states = parseCapabilityStates(body.deviceStates?.[0]?.capabilityStates);
      }
      return minifiedResult({ name: entity.name, modes: controllers(raw, legacy, states) });
    },
  );

  server.registerTool(
    'alexa_set_device_mode',
    {
      description:
        'Change a mode setting on an Alexa smart-home device: a thermostat’s fan mode (e.g. "Circulate"), a robot ' +
        'vacuum’s mode, a light effect, and similar. `setting` picks the mode control by name (e.g. "Fan Mode") ' +
        'when the device has several; `mode` is the value by name or id, as alexa_list_device_modes shows them. ' +
        'Garage doors are not changed here: use alexa_garage_door.' +
        WRITE_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: false, idempotent: true }),
      inputSchema: z.object({
        target: z.string().min(1).describe('Device name (or id) from alexa_list_smart_home.'),
        mode: z.string().min(1).max(100).describe('The new value, by name ("Circulate") or value ("3").'),
        setting: z.string().min(1).max(100).optional().describe('Which mode control, by name ("Fan Mode") or instance. Optional when the device has one.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ target, mode, setting, confirmToken }, ctx) => {
      const { entity, raw, legacy } = await resolve(client, target);
      if (isGarageDoor(raw)) {
        throw new McpToolError(`${entity.name} is a garage door.`, { hint: 'Open or close it with alexa_garage_door.' });
      }
      const all = controllers(raw, legacy).filter((c) => c.instance !== GARAGE_INSTANCE);
      if (all.length === 0) throw new McpToolError(`${entity.name} has no mode settings.`, { hint: 'alexa_list_smart_home shows each device’s actions.' });
      const list = all.map((c) => `${c.setting}: ${describeOptions(c)}`).join('; ');
      let ctl: ModeController | undefined;
      if (setting) {
        const w = setting.trim().toLowerCase();
        ctl = all.find((c) => c.instance.toLowerCase() === w) ?? all.find((c) => c.setting.toLowerCase() === w);
        if (!ctl) throw new McpToolError(`${entity.name} has no mode setting "${setting}".`, { hint: `Its settings: ${list}.` });
      } else if (all.length === 1) {
        ctl = all[0];
      } else {
        throw new McpToolError(`${entity.name} has several mode settings; say which.`, { hint: `Pass setting: ${list}.` });
      }
      const option = matchOption(ctl, mode);
      if (!option && ctl.options.length > 0) {
        throw new McpToolError(`"${mode}" is not a value of ${entity.name}'s ${ctl.setting}.`, { hint: `Values: ${describeOptions(ctl)}.` });
      }
      const value = option?.value ?? mode;
      const label = option?.name ?? value;
      const parameters = setModeValue(ctl.instance, value);
      const gate = await confirmWrite(ctx, {
        tool: 'alexa_set_device_mode',
        action: 'alexa.set_device_mode',
        summary: `Set ${entity.name} ${ctl.setting} to ${label}`,
        account: undefined,
        target: entity.id,
        payload: { entityId: entity.id, parameters },
        confirmToken,
      });
      if (gate) return gate;
      await client.controlSmartHome(entity.id, parameters, 'APPLIANCE');
      return minifiedResult({ ok: true, target: entity.name, setting: ctl.setting, mode: label, value });
    },
  );

  server.registerTool(
    'alexa_garage_door',
    {
      description:
        'Open or close a garage door connected to Alexa. Opening a garage door reduces your home’s security — ' +
        'anyone outside can walk in — so confirm the user really wants it open.' +
        WRITE_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: true }),
      inputSchema: z.object({
        target: z.string().min(1).describe('Garage door name (or id) from alexa_list_smart_home.'),
        action: z.enum(['open', 'close']).describe('open or close.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ target, action, confirmToken }, ctx) => {
      const { entity, raw, legacy } = await resolve(client, target);
      const instances = modeInstances(raw);
      const instance = instances.includes(GARAGE_INSTANCE)
        ? GARAGE_INSTANCE
        : isGarageDoor(raw) && instances.length === 1
          ? instances[0]
          : undefined;
      if (!instance) {
        throw new McpToolError(`${entity.name} is not a garage door this server can operate.`, {
          hint: 'alexa_list_smart_home shows open/close for garage doors.',
        });
      }
      const ctl = controllers(raw, legacy).find((c) => c.instance === instance) as ModeController;
      // Prefer the device's own declared modes (by friendly name, then the standard value), then the literals.
      const standard = action === 'open' ? 'Position.Up' : 'Position.Down';
      const byName = ctl.options.find((o) => (action === 'open' ? /^open/i : /^clos/i).test(o.name ?? ''));
      const option = byName ?? ctl.options.find((o) => o.value === standard);
      if (!option && ctl.options.length > 0) {
        throw new McpToolError(`Could not tell which of ${entity.name}'s positions means "${action}".`, {
          hint: `Declared positions: ${describeOptions(ctl)}.`,
        });
      }
      const parameters = setModeValue(instance, option?.value ?? standard);
      const gate = await confirmWrite(ctx, {
        tool: 'alexa_garage_door',
        action: `alexa.garage_door.${action}`,
        summary: `${action === 'open' ? 'OPEN' : 'Close'} ${entity.name}`,
        account: undefined,
        target: entity.id,
        payload: { entityId: entity.id, parameters },
        confirmToken,
      });
      if (gate) return gate;
      await client.controlSmartHome(entity.id, parameters, 'APPLIANCE');
      return minifiedResult({ ok: true, target: entity.name, action });
    },
  );

  server.registerTool(
    'alexa_lock',
    {
      description:
        'Lock or unlock a smart lock (door lock) connected to Alexa. Unlocking reduces your home’s security, so ' +
        'confirm the user really wants it unlocked. Amazon may require a voice PIN or the Alexa app to unlock; ' +
        'its refusal is reported as an error.' +
        WRITE_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: true }),
      inputSchema: z.object({
        target: z.string().min(1).describe('Lock name (or id) from alexa_list_smart_home.'),
        action: z.enum(['lock', 'unlock']).describe('lock or unlock.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ target, action, confirmToken }, ctx) => {
      const entity = findEntity(await client.listSmartHomeEntities(), target);
      if (!entity.actions.includes(action)) {
        throw new McpToolError(`${entity.name} does not support ${action}.`, {
          hint: 'alexa_list_smart_home shows lock/unlock for smart locks.',
        });
      }
      const parameters =
        action === 'lock'
          ? { action: 'lockAction', 'targetLockState.value': 'LOCKED' }
          : { action: 'unlockAction', 'targetLockState.value': 'UNLOCKED' };
      const gate = await confirmWrite(ctx, {
        tool: 'alexa_lock',
        action: `alexa.lock.${action}`,
        summary: `${action === 'unlock' ? 'UNLOCK' : 'Lock'} ${entity.name}`,
        account: undefined,
        target: entity.id,
        payload: { entityId: entity.id, parameters },
        confirmToken,
      });
      if (gate) return gate;
      try {
        await client.controlSmartHome(entity.id, parameters, 'APPLIANCE');
      } catch (err) {
        throw new McpToolError((err as Error).message, {
          hint: 'This lock may require unlocking in the Alexa app (Amazon can ask for a voice PIN), or it may be offline.',
          cause: err,
        });
      }
      return minifiedResult({ ok: true, target: entity.name, action });
    },
  );
}
