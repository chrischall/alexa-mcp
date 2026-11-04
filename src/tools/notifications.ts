import type { McpServer } from '@modelcontextprotocol/server';
import {
  McpToolError,
  UNTRUSTED_DESCRIPTION_SUFFIX,
  confirmTokenParam,
  confirmWrite,
  minifiedResult,
  rawTextResult,
  toolAnnotations,
  untrustedResult,
} from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { AlexaClient } from '../client.js';
import { homeMeta } from './hints.js';
import type { RawDevice } from '../remote.js';
import { compactNotification } from '../views.js';
import { WRITE_SUFFIX, deviceArg } from './common.js';

type Rec = Record<string, unknown>;

/** ISO 8601 with an explicit offset — the only unambiguous absolute time a model can hand us. */
const ISO_WITH_OFFSET = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

export interface WallClock {
  date: string;
  time: string;
}

/** Wall-clock date/time of an instant in an IANA zone (the server's own zone when none is given). */
export function wallClock(ms: number, timeZone?: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

/**
 * Overwrite the library's wall-clock fields. alexa-remote2 derives them from
 * the instant in the SERVER's local zone, but Alexa reads them in the DEVICE's
 * zone — on a UTC host that is hours off. New-style alarms carry only
 * `trigger.scheduledTime`; reminders and timers carry originalDate/Time.
 */
function applyWallClock(n: Rec, wall: WallClock, ms: number): Rec {
  if (n.trigger && typeof n.trigger === 'object') {
    return { ...n, trigger: { ...(n.trigger as Rec), scheduledTime: `${wall.date}T${wall.time}` } };
  }
  return { ...n, alarmTime: ms, originalDate: wall.date, originalTime: `${wall.time}.000` };
}

function requireCapability(dev: RawDevice, capability: 'REMINDERS' | 'TIMERS_AND_ALARMS'): void {
  if (!(dev.capabilities ?? []).includes(capability)) {
    const what = capability === 'REMINDERS' ? 'reminders' : 'alarms and timers';
    throw new McpToolError(`${dev.accountName ?? dev.serialNumber} does not support ${what}.`, {
      hint: 'Pick an Echo speaker or Echo Show from alexa_list_devices.',
    });
  }
}

/** A calendar date, or an ISO date-time whose date part is used. */
const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, 'YYYY-MM-DD or an ISO 8601 date-time');

const BRIEF_MAX = 120;

type Listed = ReturnType<typeof compactNotification>;

/**
 * One alarm, timer or reminder as one line — `title — <ISO date | no date> —
 * <status>`, at most 120 characters (the title is shortened). The title is the
 * kind, its label and the device it is on; the date is the next occurrence's
 * wall-clock date and time; the status is on/off, and "repeats" when recurring.
 */
export function briefLine(n: Listed): string {
  const kind = n.type ?? 'Notification';
  const title = `${n.label ? `${kind}: ${n.label}` : kind}${n.device ? ` on ${n.device}` : ''}`;
  const when = n.date ? (n.time ? `${n.date}T${n.time}` : n.date) : 'no date';
  const status = `${n.on ? 'on' : 'off'}${n.recurring ? ', repeats' : ''}`;
  const tail = ` — ${when} — ${status}`;
  const room = BRIEF_MAX - tail.length;
  const shown = title.length > room ? `${title.slice(0, Math.max(room - 1, 0))}…` : title;
  return `${shown}${tail}`;
}

export function registerNotificationTools(server: McpServer, client: AlexaClient): void {
  server.registerTool(
    'alexa_list_alarms_reminders',
    {
      description:
        'List the alarms, timers and reminders set on the account’s Alexa devices, with id, label, device, ' +
        'date/time, whether each is on, and its recurrence. Optionally filter by type, or to a date window ' +
        '(startDate/endDate). view "brief" answers one line per item. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ readOnly: true, openWorld: true }),
      _meta: homeMeta('whats-on', {
        canonical: true,
        when: { start: 'startDate', end: 'endDate' },
        aliases: ['alarms', 'reminders', 'timers', 'alarm clock', 'wake up'],
      }),
      inputSchema: z.object({
        type: z.enum(['Alarm', 'Timer', 'Reminder']).optional().describe('Only this kind.'),
        includeOff: z.boolean().default(false).describe('Also return alarms/reminders that are switched off.'),
        startDate: dateArg.optional().describe('Only items on or after this date (YYYY-MM-DD, or an ISO date-time). Undated items are left out.'),
        endDate: dateArg.optional().describe('Only items on or before this date (YYYY-MM-DD, or an ISO date-time). Undated items are left out.'),
        view: z
          .enum(['full', 'brief'])
          .default('full')
          .describe('"full" (default): one record per item. "brief": one text line per item — title — <ISO date or "no date"> — <on|off>.'),
      }),
    },
    async ({ type, includeOff, startDate, endDate, view }) => {
      const [{ notifications = [] }, devices] = await Promise.all([client.listNotifications(), client.listDevices()]);
      const names = new Map(devices.map((d) => [d.serialNumber, d.accountName]));
      const from = startDate?.slice(0, 10);
      const to = endDate?.slice(0, 10);
      const rows = notifications
        .map(compactNotification)
        .filter((n) => (!type || n.type === type) && (includeOff || n.on))
        .filter((n) => (!from && !to) || (n.date !== null && (!from || n.date >= from) && (!to || n.date <= to)))
        .map((n) => ({ ...n, device: (n.device && names.get(n.device)) ?? n.device }));
      if (view === 'brief') return rawTextResult(rows.length ? rows.map(briefLine).join('\n') : 'No alarms, timers or reminders.');
      return untrustedResult(rows);
    },
  );

  server.registerTool(
    'alexa_create_reminder',
    {
      description:
        'Set an Alexa reminder (Alexa says the label at that time) or an alarm on an Echo device. Give the time ' +
        'either as `at`, ISO 8601 WITH a UTC offset (e.g. 2026-10-09T09:00:00-04:00), or as `inMinutes` from now. ' +
        'The time is applied in the device’s own time zone. Use alexa_create_timer for a countdown timer.' +
        WRITE_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: false, openWorld: true }),
      _meta: homeMeta('change', { aliases: ['remind me', 'reminder', 'alarm', 'wake me up'] }),
      inputSchema: z.object({
        device: deviceArg,
        type: z.enum(['Reminder', 'Alarm']).default('Reminder').describe('"Reminder" (default) or "Alarm".'),
        label: z.string().min(1).max(200).optional().describe('What Alexa reminds you of, e.g. "call mom". Required for reminders.'),
        at: z
          .string()
          .regex(ISO_WITH_OFFSET, 'ISO 8601 with an offset, e.g. 2026-10-09T09:00:00-04:00')
          .optional()
          .describe('When, as ISO 8601 with a UTC offset, e.g. 2026-10-09T09:00:00-04:00.'),
        inMinutes: z.number().int().min(1).max(525_600).optional().describe('Or: this many minutes from now.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ device, type, label, at, inMinutes, confirmToken }, ctx) => {
      if ((at === undefined) === (inMinutes === undefined)) {
        throw new McpToolError('Pass exactly one of `at` or `inMinutes`.');
      }
      if (type === 'Reminder' && !label) throw new McpToolError('A reminder needs a label (what to remind you of).');
      const dev = await client.resolveDevice(device);
      requireCapability(dev, type === 'Reminder' ? 'REMINDERS' : 'TIMERS_AND_ALARMS');
      const ms = at !== undefined ? Date.parse(at) : Date.now() + (inMinutes as number) * 60_000;
      if (!Number.isFinite(ms)) throw new McpToolError(`"${at}" is not a valid time.`);
      if (ms <= Date.now()) throw new McpToolError(`${at} is in the past.`);
      const zone = await client.deviceTimeZone(dev.serialNumber);
      const m = at ? ISO_WITH_OFFSET.exec(at) : null;
      // Device zone when known; else the literal wall clock the caller wrote; else this server's zone.
      const wall = zone ? wallClock(ms, zone) : m ? { date: m[1], time: `${m[2]}:${m[3]}:${m[4] ?? '00'}` } : wallClock(ms);
      const gate = await confirmWrite(ctx, {
        tool: 'alexa_create_reminder',
        action: `alexa.create_${type.toLowerCase()}`,
        summary: `${type} on ${dev.accountName} at ${wall.date} ${wall.time.slice(0, 5)}${zone ? ` (${zone})` : ''}${label ? `: "${label}"` : ''}`,
        account: undefined,
        target: dev.serialNumber,
        payload: { device: dev.serialNumber, type, label: label ?? null, wall },
        confirmToken,
      });
      if (gate) return gate;
      const created = await client.createAlert({
        serial: dev.serialNumber,
        type,
        label: label ?? null,
        timeMs: ms,
        edit: (n) => applyWallClock(n, wall, ms),
      });
      return minifiedResult({ ok: true, id: created.id, type, device: dev.accountName, date: wall.date, time: wall.time.slice(0, 5) });
    },
  );

  server.registerTool(
    'alexa_create_timer',
    {
      description: 'Start an Alexa countdown timer on an Echo device, e.g. a 10-minute pasta timer.' + WRITE_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: false, openWorld: true }),
      _meta: homeMeta('change', { aliases: ['timer', 'countdown'] }),
      inputSchema: z.object({
        device: deviceArg,
        minutes: z.number().min(0.5).max(1440).describe('Duration in minutes (0.5–1440).'),
        label: z.string().min(1).max(100).optional().describe('Optional timer name, e.g. "pasta".'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ device, minutes, label, confirmToken }, ctx) => {
      const dev = await client.resolveDevice(device);
      requireCapability(dev, 'TIMERS_AND_ALARMS');
      const durationMs = Math.round(minutes * 60_000);
      const gate = await confirmWrite(ctx, {
        tool: 'alexa_create_timer',
        action: 'alexa.create_timer',
        summary: `${minutes}-minute timer${label ? ` "${label}"` : ''} on ${dev.accountName}`,
        account: undefined,
        target: dev.serialNumber,
        payload: { device: dev.serialNumber, durationMs, label: label ?? null },
        confirmToken,
      });
      if (gate) return gate;
      const ends = Date.now() + durationMs;
      const zone = await client.deviceTimeZone(dev.serialNumber);
      const wall = wallClock(ends, zone);
      const created = await client.createAlert({
        serial: dev.serialNumber,
        type: 'Timer',
        label: label ?? null,
        timeMs: ends,
        // The library ignores the value for timers; Alexa timers carry their duration as remainingTime.
        edit: (n) => ({ ...applyWallClock(n, wall, ends), remainingTime: durationMs }),
      });
      return minifiedResult({ ok: true, id: created.id, device: dev.accountName, minutes, label: label ?? null });
    },
  );

  server.registerTool(
    'alexa_cancel_alarm_reminder',
    {
      description:
        'Cancel (delete) an Alexa alarm, timer or reminder — by its id from alexa_list_alarms_reminders, or by its ' +
        'label (plus the device when the same label is on several). A recurring alarm is deleted entirely, not ' +
        'just its next occurrence.' +
        WRITE_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: true, openWorld: true }),
      _meta: homeMeta('change', { aliases: ['cancel alarm', 'cancel reminder', 'cancel timer'] }),
      inputSchema: z.object({
        id: z.string().min(1).optional().describe('Notification id from alexa_list_alarms_reminders.'),
        label: z.string().min(1).optional().describe('Or: the reminder/timer label (case-insensitive).'),
        device: deviceArg.optional().describe('With label: the device it is on.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ id, label, device, confirmToken }, ctx) => {
      if (!id && !label) throw new McpToolError('Pass the id (from alexa_list_alarms_reminders) or a label.');
      const { notifications = [] } = await client.listNotifications();
      const dev = device ? await client.resolveDevice(device) : undefined;
      let found: Rec | undefined;
      if (id) {
        found = notifications.find((n) => n.id === id);
        if (!found) throw new McpToolError(`No alarm, timer or reminder has id "${id}".`, { hint: 'alexa_list_alarms_reminders lists them.' });
      } else {
        const q = (label as string).trim().toLowerCase();
        const matches = notifications.filter(
          (n) =>
            (compactNotification(n).label ?? '').toLowerCase() === q && (!dev || n.deviceSerialNumber === dev.serialNumber),
        );
        if (matches.length !== 1) {
          throw new McpToolError(
            matches.length ? `"${label}" matches more than one alarm/reminder.` : `No alarm, timer or reminder is labelled "${label}".`,
            { hint: matches.length ? 'Pass the device, or the id from alexa_list_alarms_reminders.' : 'alexa_list_alarms_reminders lists them.' },
          );
        }
        found = matches[0];
      }
      const c = compactNotification(found);
      const gate = await confirmWrite(ctx, {
        tool: 'alexa_cancel_alarm_reminder',
        action: 'alexa.cancel_notification',
        summary: `Delete ${c.type ?? 'notification'}${c.label ? ` "${c.label}"` : ''}${c.date ? ` (${c.date} ${c.time ?? ''})` : ''}`,
        account: undefined,
        target: String(found.id),
        payload: { id: found.id },
        confirmToken,
      });
      if (gate) return gate;
      await client.deleteNotification(found);
      return minifiedResult({ ok: true, deleted: c.id, type: c.type });
    },
  );
}
