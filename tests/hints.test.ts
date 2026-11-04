import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { AlexaClient } from '../src/client.js';
import { TOOL_REGISTRARS } from '../src/registrars.js';
import { DEVICES, REGISTRATION, type Handlers, fakeRemote } from './fakes.js';

/**
 * Context-group hints (`_meta.mint`, the mcp-host context-groups contract),
 * asserted on what a host sees: the served `tools/list`.
 */

type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, { enum?: unknown[] }> };
  _meta?: { mint?: Record<string, unknown> };
};

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];

/** The intent every tool declares — this table is the assertion, so a new tool cannot skip the decision. */
const EXPECTED_INTENT: Record<string, string> = {
  alexa_session_status: 'lookup',
  alexa_begin_login: 'other',
  alexa_finish_login: 'other',
  alexa_list_devices: 'lookup',
  alexa_get_now_playing: 'lookup',
  alexa_list_volumes: 'lookup',
  alexa_set_volume: 'change',
  alexa_playback: 'other',
  alexa_speak: 'send',
  alexa_list_routines: 'lookup',
  alexa_run_routine: 'other',
  alexa_list_smart_home: 'lookup',
  alexa_control_smart_home: 'turn-on-off',
  alexa_get_smart_home_state: 'lookup',
  alexa_set_thermostat: 'change',
  alexa_list_lists: 'lookup',
  alexa_get_list_items: 'lookup',
  alexa_add_list_item: 'change',
  alexa_update_list_item: 'change',
  alexa_remove_list_item: 'change',
  alexa_list_alarms_reminders: 'whats-on',
  alexa_create_reminder: 'change',
  alexa_create_timer: 'change',
  alexa_cancel_alarm_reminder: 'change',
  alexa_get_do_not_disturb: 'lookup',
  alexa_set_do_not_disturb: 'turn-on-off',
  alexa_get_equalizer: 'lookup',
  alexa_set_equalizer: 'change',
  alexa_list_bluetooth: 'lookup',
  alexa_run_builtin: 'other',
  alexa_fire_tv: 'turn-on-off',
  alexa_stop: 'other',
  alexa_set_vacation_mode: 'turn-on-off',
  alexa_list_device_modes: 'lookup',
  alexa_set_device_mode: 'change',
  alexa_garage_door: 'turn-on-off',
  alexa_lock: 'turn-on-off',
};

const NOTIFICATIONS = [
  { id: 'n-alarm', type: 'Alarm', status: 'ON', deviceSerialNumber: 'G0001', originalDate: '2026-10-08', originalTime: '06:30:00.000', recurringPattern: 'P1D' },
  { id: 'n-rem', type: 'Reminder', status: 'ON', reminderLabel: 'water the plants', deviceSerialNumber: 'G0001', originalDate: '2026-10-09', originalTime: '09:00:00.000' },
  { id: 'n-off', type: 'Alarm', status: 'OFF', deviceSerialNumber: 'G0001', originalDate: '2026-10-10', originalTime: '07:00:00.000' },
  { id: 'n-long', type: 'Reminder', status: 'ON', reminderLabel: 'x'.repeat(300), deviceSerialNumber: 'G0001', originalDate: '2026-10-11', originalTime: '19:00:00.000' },
  { id: 'n-undated', type: 'Timer', status: 'ON', timerLabel: 'pasta', deviceSerialNumber: 'G0001' },
];

const HANDLERS: Handlers = {
  getDevices: () => ({ devices: DEVICES }),
  getNotifications: () => ({ notifications: NOTIFICATIONS }),
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alexa-hints-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const remote = fakeRemote(HANDLERS);
  const client = new AlexaClient({
    env: { HOME: dir, ALEXA_STATE_DIR: dir, ALEXA_REGISTRATION: JSON.stringify(REGISTRATION) },
    factory: remote.factory,
    refresh: async (r) => ({ ...r, csrf: 'c', localCookie: 'csrf=c' }),
    fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
  });
  return createTestHarness((server) => {
    for (const register of TOOL_REGISTRARS) register(server, client);
  });
}

async function served(): Promise<Listed[]> {
  const h = await setup();
  const { tools } = await h.client.listTools();
  await h.close();
  return tools as unknown as Listed[];
}

const text = (r: { content?: unknown }) => ((r.content as { text: string }[])[0]?.text ?? '');

describe('_meta.mint on tools/list', () => {
  it('every tool except the healthcheck is hinted, and the table names every one', async () => {
    const tools = await served();
    const hinted = tools.filter((t) => t._meta?.mint).map((t) => t.name).sort();
    expect(hinted).toEqual(Object.keys(EXPECTED_INTENT).sort());
    // alexa_healthcheck is registered by mcp-utils, which takes no _meta: it joins no group.
    expect(tools.filter((t) => !t._meta?.mint).map((t) => t.name)).toEqual(['alexa_healthcheck']);
  });

  it.each(Object.entries(EXPECTED_INTENT))('%s is in the home group with intent %s', async (name, intent) => {
    const mint = (await served()).find((t) => t.name === name)?._meta?.mint;
    expect(mint).toBeDefined();
    expect(mint!.domain).toBe('home');
    expect(mint!.intent).toBe(intent);
  });

  it('every hint is shaped per the host contract', async () => {
    for (const t of await served()) {
      const mint = t._meta?.mint;
      if (!mint) continue;
      const props = t.inputSchema.properties ?? {};
      expect(Object.keys(mint).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(mint.domain);
      expect(INTENTS, t.name).toContain(mint.intent);
      if ('canonical' in mint) {
        expect(mint.canonical, t.name).toBe(true);
        expect(t.annotations?.readOnlyHint, t.name).toBe(true);
        expect(CANONICAL_INTENTS, t.name).toContain(mint.intent);
      }
      if ('subject' in mint) expect(props, t.name).toHaveProperty(mint.subject as string);
      if ('when' in mint) {
        const when = mint.when as Record<string, string>;
        expect(Object.keys(when).sort(), t.name).toEqual(['end', 'start']);
        expect(props, t.name).toHaveProperty(when.start);
        expect(props, t.name).toHaveProperty(when.end);
      }
      if ('aliases' in mint) {
        const aliases = mint.aliases as string[];
        expect(aliases.length, t.name).toBeGreaterThan(0);
        expect(aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
          expect(a, t.name).not.toMatch(/^alexa_/);
        }
      }
    }
  });

  it('at most one canonical read per what’s-new/due/on: the alarm and reminder list answers what’s on', async () => {
    const canonical = (await served())
      .filter((t) => t._meta?.mint?.canonical === true)
      .map((t) => [t.name, t._meta!.mint!.intent]);
    expect(canonical).toEqual([['alexa_list_alarms_reminders', 'whats-on']]);
    for (const intent of CANONICAL_INTENTS) {
      expect(canonical.filter(([, i]) => i === intent).length, intent).toBeLessThanOrEqual(1);
    }
  });

  it('the canonical read names its range arguments and takes no subject (Echo devices are not a person’s subject)', async () => {
    const t = (await served()).find((x) => x.name === 'alexa_list_alarms_reminders')!;
    expect(t._meta?.mint).toEqual({
      domain: 'home',
      intent: 'whats-on',
      canonical: true,
      when: { start: 'startDate', end: 'endDate' },
      aliases: ['alarms', 'reminders', 'timers', 'alarm clock', 'wake up'],
    });
    expect(t.inputSchema.properties?.view?.enum).toEqual(['full', 'brief']);
  });
});

describe('alexa_list_alarms_reminders view: brief', () => {
  const SHAPE = /^.+ — (\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?|no date) — .+$/;

  it('answers one line per item, each ≤ 120 chars, "title — <ISO date | no date> — <status>"', async () => {
    const h = await setup();
    const lines = text(await h.callTool('alexa_list_alarms_reminders', { view: 'brief', includeOff: true })).split('\n');
    await h.close();
    expect(lines).toHaveLength(NOTIFICATIONS.length);
    for (const line of lines) {
      expect(line.length, line).toBeLessThanOrEqual(120);
      expect(line, line).toMatch(SHAPE);
    }
    expect(lines[0]).toBe('Alarm on Kitchen Echo — 2026-10-08T06:30 — on, repeats');
    expect(lines[1]).toBe('Reminder: water the plants on Kitchen Echo — 2026-10-09T09:00 — on');
    expect(lines[2]).toBe('Alarm on Kitchen Echo — 2026-10-10T07:00 — off');
    expect(lines[3]).toMatch(/^Reminder: x+… — 2026-10-11T19:00 — on$/);
    expect(lines[4]).toBe('Timer: pasta on Kitchen Echo — no date — on');
  });

  it('keeps the switched-off filter and says so when nothing is set', async () => {
    const h = await setup();
    const out = text(await h.callTool('alexa_list_alarms_reminders', { view: 'brief', type: 'Alarm' }));
    expect(out.split('\n')).toEqual(['Alarm on Kitchen Echo — 2026-10-08T06:30 — on, repeats']);
    const none = text(await h.callTool('alexa_list_alarms_reminders', { view: 'brief', startDate: '2030-01-01' }));
    await h.close();
    expect(none).toBe('No alarms, timers or reminders.');
  });

  it('startDate/endDate keep the dated items in the window (inclusive), in full and brief views', async () => {
    const h = await setup();
    const brief = text(
      await h.callTool('alexa_list_alarms_reminders', { view: 'brief', includeOff: true, startDate: '2026-10-09', endDate: '2026-10-10T23:59:00-04:00' }),
    ).split('\n');
    expect(brief.map((l) => l.split(' — ')[1])).toEqual(['2026-10-09T09:00', '2026-10-10T07:00']);
    const full = text(await h.callTool('alexa_list_alarms_reminders', { startDate: '2026-10-11' }));
    await h.close();
    expect(full).toContain('n-long');
    expect(full).not.toContain('n-rem');
    expect(full).not.toContain('n-undated');
  });

  it('refuses a date it cannot read', async () => {
    const h = await setup();
    const r = await h.callTool('alexa_list_alarms_reminders', { startDate: 'tomorrow' });
    await h.close();
    expect(r.isError).toBe(true);
  });
});
