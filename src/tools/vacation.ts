import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { McpToolError, confirmTokenParam, confirmWrite, minifiedResult, toolAnnotations, writeFileSafe } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { AlexaClient } from '../client.js';
import { compactSmartHomeEntity } from '../views.js';
import { WRITE_SUFFIX } from './common.js';
import {
  type Entity,
  type Range,
  type TempScale,
  dualSetpoint,
  findEntity,
  modeCommand,
  readStates,
  singleSetpoint,
  thermostatContext,
} from './smarthome.js';

/**
 * "Vacation mode" for thermostats, EMULATED. Amazon Smart Thermostats expose
 * only HEAT/COOL/AUTO/OFF through this API (no ECO/AWAY/VACATION; live
 * 2026-10-08), so enabling widens the setpoints to heatTo/coolTo and disabling
 * puts back what was there. The original settings are snapshotted to
 * `<stateDir>/vacation.json` BEFORE anything changes, and an existing snapshot
 * is never overwritten — enabling twice is refused.
 */

interface Saved {
  name: string;
  mode: string;
  lower?: number;
  upper?: number;
  target?: number;
  scale: TempScale;
  savedAt: string;
}
interface Snapshot {
  version: 1;
  thermostats: Record<string, Saved>;
}

export const vacationPath = (client: AlexaClient) => join(client.stateDir, 'vacation.json');

async function loadSnapshot(path: string): Promise<Snapshot> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Snapshot;
    return { version: 1, thermostats: parsed.thermostats ?? {} };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, thermostats: {} };
    throw new McpToolError(`The vacation-mode snapshot at ${path} is unreadable: ${(err as Error).message}.`, {
      hint: 'It holds the thermostat settings to restore; fix or remove it by hand.',
    });
  }
}

async function saveSnapshot(path: string, snap: Snapshot): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await writeFileSafe(path, new TextEncoder().encode(JSON.stringify(snap, null, 2)), { overwrite: true, mode: 0o600 });
}

const clamp = (v: number, r: Range | undefined) => (r ? Math.min(r.max, Math.max(r.min, v)) : v);
const fmt = (s: { mode?: string; lower?: number; upper?: number; target?: number }) =>
  s.mode === 'OFF' || (s.lower === undefined && s.target === undefined)
    ? `${s.mode ?? '?'}`
    : s.lower !== undefined && s.upper !== undefined
      ? `${s.mode ?? '?'} ${s.lower}–${s.upper}°`
      : `${s.mode ?? '?'} ${s.target}°`;

interface Plan {
  entity: Entity;
  commands: Record<string, unknown>[];
  from: string;
  to: string;
  save?: Saved;
  skipped?: string;
  error?: string;
  note?: string;
}

export function registerVacationTools(server: McpServer, client: AlexaClient): void {
  server.registerTool(
    'alexa_set_vacation_mode',
    {
      description:
        'Turn thermostat vacation mode (away mode) on or off. Alexa thermostats have no native vacation or away ' +
        'mode, so this emulates one: turning it ON saves each thermostat’s current mode and temperature setpoints, ' +
        'then sets energy-saving setpoints (heat to 55°, cool to 85° by default, in the thermostat’s own scale) — ' +
        'a thermostat that is OFF stays OFF. Turning it OFF restores exactly what was saved. Defaults to every ' +
        'thermostat. Turning it on twice is refused so the saved settings are never lost.' +
        WRITE_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: false }),
      inputSchema: z.object({
        enabled: z.boolean().describe('true turns vacation mode on; false restores the saved settings.'),
        targets: z.array(z.string().min(1)).min(1).max(20).optional().describe('Thermostat names (or ids). Default: all thermostats.'),
        heatTo: z.number().min(-50).max(120).optional().describe('Vacation heat-to setpoint, in the thermostat’s scale. Default 55 °F / 13 °C.'),
        coolTo: z.number().min(-50).max(120).optional().describe('Vacation cool-to setpoint, in the thermostat’s scale. Default 85 °F / 29 °C.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ enabled, targets, heatTo, coolTo, confirmToken }, ctx) => {
      const path = vacationPath(client);
      const snap = await loadSnapshot(path);
      const all = await client.listSmartHomeEntities();
      let entities: Entity[];
      if (targets) {
        entities = [...new Map(targets.map((t) => findEntity(all, t)).map((e) => [e.id, e])).values()];
      } else if (enabled) {
        entities = all.map(compactSmartHomeEntity).filter((e) => e.kind?.toUpperCase() === 'THERMOSTAT');
      } else {
        const ids = new Set(Object.keys(snap.thermostats));
        entities = all.map(compactSmartHomeEntity).filter((e) => ids.has(e.id));
      }

      if (!enabled) {
        const saved = entities.filter((e) => snap.thermostats[e.id]);
        if (saved.length === 0) {
          throw new McpToolError('Vacation mode is not on: there are no saved thermostat settings to restore.', {
            hint: 'alexa_set_thermostat changes a thermostat directly.',
          });
        }
        entities = saved;
      } else {
        if (entities.length === 0) throw new McpToolError('No thermostats were found.', { hint: 'alexa_list_smart_home kind THERMOSTAT lists them.' });
        const already = entities.filter((e) => snap.thermostats[e.id]);
        if (already.length > 0) {
          throw new McpToolError(`Vacation mode is already on for ${already.map((e) => e.name).join(', ')}.`, {
            hint: 'Turn vacation mode off first (enabled: false); turning it on again would overwrite the saved settings.',
          });
        }
      }

      const reads = await readStates(client, entities);
      const plans: Plan[] = reads.map(({ entity, states, error }) => {
        const base = { entity, commands: [] as Record<string, unknown>[], from: '?', to: '?' };
        if (error || !states) return { ...base, error: error ?? 'no state' };
        const t = thermostatContext(states);
        const from = fmt(t);
        if (enabled) {
          if (t.mode === 'OFF') return { ...base, from, to: 'OFF', skipped: 'thermostat is OFF; left OFF' };
          const celsius = t.ownScale === 'celsius';
          const heat = heatTo ?? (celsius ? 13 : 55);
          const cool = coolTo ?? (celsius ? 29 : 85);
          const save: Saved = { name: entity.name, mode: t.mode ?? 'AUTO', lower: t.lower, upper: t.upper, target: t.target, scale: t.ownScale, savedAt: new Date().toISOString() };
          if (t.mode === 'AUTO' || (t.mode === undefined && t.lower !== undefined && t.upper !== undefined)) {
            const lo = clamp(heat, t.heat);
            const hi = clamp(cool, t.cool);
            if (lo >= hi) return { ...base, from, error: `heat-to ${lo}° must be below cool-to ${hi}°` };
            const note = lo !== heat || hi !== cool ? `clamped to the allowed range (${lo}–${hi}°)` : undefined;
            return { ...base, from, to: `AUTO ${lo}–${hi}°`, commands: [dualSetpoint(lo, hi, t.ownScale)], save, note };
          }
          if (t.mode === 'HEAT' || t.mode === 'COOL') {
            const want = t.mode === 'HEAT' ? heat : cool;
            const v = clamp(want, t.mode === 'HEAT' ? t.heat : t.cool);
            const note = v !== want ? `clamped to the allowed range (${v}°)` : undefined;
            return { ...base, from, to: `${t.mode} ${v}°`, commands: [singleSetpoint(v, t.ownScale)], save, note };
          }
          return { ...base, from, error: `unsupported thermostat mode ${t.mode ?? 'unknown'}` };
        }
        // Restore.
        const s = snap.thermostats[entity.id];
        const commands: Record<string, unknown>[] = [];
        if (t.mode !== s.mode) commands.push(modeCommand(s.mode));
        if (s.mode === 'AUTO' && s.lower !== undefined && s.upper !== undefined) commands.push(dualSetpoint(s.lower, s.upper, s.scale));
        else if ((s.mode === 'HEAT' || s.mode === 'COOL') && s.target !== undefined) commands.push(singleSetpoint(s.target, s.scale));
        return { ...base, from, to: fmt(s), commands };
      });

      const lines = plans.map(
        (p) => `${p.entity.name}: ${p.from} → ${p.error ? `cannot (${p.error})` : p.skipped ? `unchanged (${p.skipped})` : p.to}${p.note ? ` [${p.note}]` : ''}`,
      );
      const gate = await confirmWrite(ctx, {
        tool: 'alexa_set_vacation_mode',
        action: enabled ? 'alexa.vacation_on' : 'alexa.vacation_off',
        summary: `Vacation mode ${enabled ? 'ON' : 'OFF'} — ${lines.join('; ')}`,
        account: undefined,
        target: plans.map((p) => p.entity.id).join(','),
        payload: { enabled, plans: plans.map((p) => ({ id: p.entity.id, commands: p.commands })) },
        confirmToken,
      });
      if (gate) return gate;

      if (enabled) {
        // Snapshot BEFORE the first write, so a crash mid-way still leaves the originals on disk.
        for (const p of plans) if (p.save && !p.error && !p.skipped) snap.thermostats[p.entity.id] = p.save;
        await saveSnapshot(path, snap);
      }
      const results: Record<string, unknown>[] = [];
      for (const p of plans) {
        const row: Record<string, unknown> = { name: p.entity.name, from: p.from, to: p.to };
        if (p.error) {
          results.push({ ...row, ok: false, error: p.error });
          continue;
        }
        if (p.skipped) {
          results.push({ ...row, ok: true, skipped: p.skipped });
          continue;
        }
        try {
          for (const parameters of p.commands) await client.controlSmartHome(p.entity.id, parameters, 'APPLIANCE');
          if (!enabled) delete snap.thermostats[p.entity.id];
          results.push({ ...row, ok: true, ...(p.note ? { note: p.note } : {}) });
        } catch (err) {
          // Enabling: nothing changed reliably enough to restore — drop the entry so a retry is not refused.
          // (A failure after a mode change on restore keeps the entry, so a later disable can try again.)
          if (enabled) delete snap.thermostats[p.entity.id];
          results.push({ ...row, ok: false, error: (err as Error).message });
        }
      }
      await saveSnapshot(path, snap);
      return minifiedResult({ ok: results.every((r) => r.ok === true), vacationMode: enabled, results });
    },
  );
}
