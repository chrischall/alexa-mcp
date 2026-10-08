import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlexaClient, REFRESH_AFTER_MS } from '../src/client.js';
import { registrationStatePath, saveRegistration } from '../src/registration.js';
import { DEVICES, REGISTRATION, fakeRemote } from './fakes.js';

let dir: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alexa-client-'));
  env = { HOME: dir, ALEXA_STATE_DIR: dir, ALEXA_REGISTRATION: JSON.stringify(REGISTRATION) };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function make(handlers = {}, opts: { refresh?: ReturnType<typeof vi.fn>; now?: () => number } = {}) {
  const remote = fakeRemote(handlers);
  const refresh = opts.refresh ?? vi.fn(async (r) => ({ ...r, tokenDate: Date.now(), loginCookie: 'fresh' }));
  const client = new AlexaClient({ env, factory: remote.factory, refresh, now: opts.now });
  return { client, remote, refresh };
}

describe('configuration', () => {
  it('constructs without a registration and defers the error to the first call', async () => {
    env.ALEXA_REGISTRATION = undefined;
    const { client, remote } = make();
    expect(client.describeConfig()).toMatchObject({ configured: false, source: null });
    await expect(client.listDevices()).rejects.toMatchObject({ hint: expect.stringContaining('alexa-mcp login') });
    expect(remote.inits).toHaveLength(0);
  });

  it('a malformed ALEXA_REGISTRATION is a deferred error too, not a boot crash', async () => {
    env.ALEXA_REGISTRATION = 'garbage';
    const { client } = make();
    expect(client.describeConfig().configured).toBe(false);
    await expect(client.listDevices()).rejects.toThrow(/ALEXA_REGISTRATION/);
  });

  it('describeConfig reports a source label and token age, never the token', () => {
    const { client } = make();
    const cfg = client.describeConfig();
    expect(cfg).toMatchObject({ configured: true, source: 'env', amazonPage: 'amazon.com' });
    expect(JSON.stringify(cfg)).not.toContain('refresh-secret');
  });
});

describe('session lifecycle', () => {
  it('initialises once for concurrent calls (single flight)', async () => {
    const { client, remote } = make({ getDevices: () => ({ devices: DEVICES }) });
    await Promise.all([client.listDevices(), client.listDevices(), client.listDevices()]);
    expect(remote.inits).toHaveLength(1);
  });

  it('retries initialisation on the next call after a failure', async () => {
    const { client, remote } = make({ getDevices: () => ({ devices: DEVICES }) });
    remote.failNextInit(new Error('boom'));
    await expect(client.listDevices()).rejects.toThrow(/boom/);
    await expect(client.listDevices()).resolves.toHaveLength(DEVICES.length - 1);
    expect(remote.inits).toHaveLength(2);
  });

  it('refreshes a stale registration BEFORE init and persists the result', async () => {
    env.ALEXA_REGISTRATION = JSON.stringify({ ...REGISTRATION, tokenDate: Date.now() - REFRESH_AFTER_MS - 1 });
    const { client, remote, refresh } = make({ getDevices: () => ({ devices: DEVICES }) });
    await client.listDevices();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(remote.inits[0].registration.loginCookie).toBe('fresh');
    await client.flushPersistence();
    const saved = JSON.parse(readFileSync(registrationStatePath(env), 'utf8'));
    expect(saved.loginCookie).toBe('fresh');
  });

  it('does not refresh a fresh registration', async () => {
    const { client, refresh } = make({ getDevices: () => ({ devices: DEVICES }) });
    await client.listDevices();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a failed refresh still tries init with the existing cookie (it may be valid for days)', async () => {
    env.ALEXA_REGISTRATION = JSON.stringify({ ...REGISTRATION, tokenDate: 0 });
    const refresh = vi.fn(async () => {
      throw new Error('refresh down');
    });
    const { client, remote } = make({ getDevices: () => ({ devices: DEVICES }) }, { refresh });
    await expect(client.listDevices()).resolves.toHaveLength(DEVICES.length - 1);
    expect(remote.inits).toHaveLength(1);
  });

  it('persists registrations the library mints during a session', async () => {
    const { client, remote } = make({ getDevices: () => ({ devices: DEVICES }) });
    await client.listDevices();
    remote.inits[0].onRegistration({ ...REGISTRATION, loginCookie: 'minted-by-lib' });
    await client.flushPersistence();
    expect(JSON.parse(readFileSync(registrationStatePath(env), 'utf8')).loginCookie).toBe('minted-by-lib');
  });

  it('drops the session after an auth failure so the next call re-initialises', async () => {
    let first = true;
    const { client, remote } = make({
      getDevices: () => {
        if (first) {
          first = false;
          throw new Error('401 Unauthorized');
        }
        return { devices: DEVICES };
      },
    });
    await expect(client.listDevices()).rejects.toMatchObject({ hint: expect.stringContaining('signed in') });
    await client.listDevices();
    expect(remote.inits).toHaveLength(2);
  });

  it('prefers a refreshed state file for the same device over the env seed', async () => {
    await saveRegistration(registrationStatePath(env), { ...REGISTRATION, tokenDate: Date.now() + 1, loginCookie: 'from-file' });
    const { client, remote } = make({ getDevices: () => ({ devices: DEVICES }) });
    await client.listDevices();
    expect(remote.inits[0].registration.loginCookie).toBe('from-file');
  });
});

describe('device resolution', () => {
  it('resolves by serial, by exact name (case-insensitive), and by unique substring', async () => {
    const { client } = make({ getDevices: () => ({ devices: DEVICES }) });
    expect((await client.resolveDevice('G0002')).serialNumber).toBe('G0002');
    expect((await client.resolveDevice('kitchen echo')).serialNumber).toBe('G0001');
    expect((await client.resolveDevice('echo show')).serialNumber).toBe('G0002');
  });

  it('rejects an ambiguous name, listing the candidates', async () => {
    const { client } = make({ getDevices: () => ({ devices: DEVICES }) });
    await expect(client.resolveDevice('echo')).rejects.toThrow(/Kitchen Echo.*Echo Show/s);
  });

  it('rejects an unknown device, listing what exists', async () => {
    const { client } = make({ getDevices: () => ({ devices: DEVICES }) });
    await expect(client.resolveDevice('garage')).rejects.toMatchObject({ hint: expect.stringContaining('Kitchen Echo') });
  });

  it('listDevices hides the virtual device this server registered as', async () => {
    const { client } = make({ getDevices: () => ({ devices: DEVICES }) });
    const devices = await client.listDevices();
    expect(devices.map((d) => d.serialNumber)).not.toContain('virtual-device-1');
  });
});

describe('commands', () => {
  it('speak sends a speak sequence to one device', async () => {
    const { client, remote } = make({ getDevices: () => ({ devices: DEVICES }) });
    await client.speak('G0001', 'hello', 'speak');
    expect(remote.calls.at(-1)).toEqual({ method: 'sendSequenceCommand', args: ['G0001', 'speak', 'hello'] });
  });

  it('announce to several devices sends one announcement sequence to the device array', async () => {
    const { client, remote } = make({ getDevices: () => ({ devices: DEVICES }) });
    await client.announce(['G0001', 'G0002'], 'dinner');
    expect(remote.calls.at(-1)).toEqual({ method: 'sendSequenceCommand', args: [['G0001', 'G0002'], 'announcement', 'dinner'] });
  });

  it('setVolume uses a volume SEQUENCE (works idle); playback uses the player command', async () => {
    const { client, remote } = make({ getDevices: () => ({ devices: DEVICES }) });
    await client.setVolume('G0001', 30);
    expect(remote.calls.at(-1)).toEqual({ method: 'sendSequenceCommand', args: ['G0001', 'volume', 30] });
    await client.playback('G0001', 'pause');
    expect(remote.calls.at(-1)).toEqual({ method: 'sendCommand', args: ['G0001', 'pause', null] });
  });

  it('runRoutine sends the full routine object the library expects', async () => {
    const routine = { automationId: 'amzn1.alexa.automation.r1', name: 'Bedtime', status: 'ENABLED', sequence: {} };
    const { client, remote } = make({ getAutomationRoutines: () => [routine] });
    await client.runRoutine('G0001', routine);
    expect(remote.calls.at(-1)).toEqual({ method: 'executeAutomationRoutine', args: ['G0001', routine] });
  });

  it('controlSmartHome surfaces per-entity errors from a 200 response', async () => {
    const { client } = make({
      executeSmarthomeDeviceAction: () => ({ controlResponses: [], errors: [{ code: 'ENDPOINT_UNREACHABLE', entity: { entityId: 'e1' } }] }),
    });
    await expect(client.controlSmartHome('e1', { action: 'turnOn' }, 'APPLIANCE')).rejects.toThrow(/ENDPOINT_UNREACHABLE/);
  });

  it('controlSmartHome passes entity, parameters and type through', async () => {
    const { client, remote } = make({ executeSmarthomeDeviceAction: () => ({ controlResponses: [{ code: 'SUCCESS' }], errors: [] }) });
    await client.controlSmartHome('e1', { action: 'setBrightness', brightness: 40 }, 'GROUP');
    expect(remote.calls.at(-1)).toEqual({
      method: 'executeSmarthomeDeviceAction',
      args: [['e1'], { action: 'setBrightness', brightness: 40 }, 'GROUP'],
    });
  });

  it('removeListItem passes the item version the API requires', async () => {
    const { client, remote } = make();
    await client.removeListItem('list-1', 'item-1', 3);
    expect(remote.calls.at(-1)).toEqual({ method: 'deleteListItem', args: ['list-1', 'item-1', { version: 3 }] });
  });
});

describe('wider surface', () => {
  it('querySmartHomeState asks for APPLIANCE state by applianceId', async () => {
    const { client, remote } = make({ querySmarthomeDevices: () => ({ deviceStates: [], errors: [] }) });
    await client.querySmartHomeState(['a1', 'a2']);
    expect(remote.calls.at(-1)).toEqual({ method: 'querySmarthomeDevices', args: [['a1', 'a2'], 'APPLIANCE'] });
  });

  it('listSmartHomeEndpoints reads getSmarthomeDevicesV2', async () => {
    const { client, remote } = make({ getSmarthomeDevicesV2: () => [{ legacyAppliance: { applianceId: 'a1', entityId: 'e1' } }] });
    expect(await client.listSmartHomeEndpoints()).toHaveLength(1);
    expect(remote.calls.at(-1)?.method).toBe('getSmarthomeDevicesV2');
  });

  it('Do Not Disturb, equalizer, bluetooth and sequence commands pass their arguments through', async () => {
    const { client, remote } = make();
    await client.getDoNotDisturb();
    await client.setDoNotDisturb('G0001', true);
    await client.getEqualizer('G0001');
    await client.setEqualizer('G0001', 1, 2, 3);
    await client.getBluetooth();
    await client.sequence('G0001', 'joke');
    await client.updateListItem('l', 'i', { value: 'milk', completed: true, version: 2 });
    expect(remote.calls.map((c) => [c.method, ...c.args])).toEqual([
      ['getDoNotDisturb'],
      ['setDoNotDisturb', 'G0001', true],
      ['getEqualizerSettings', 'G0001'],
      ['setEqualizerSettings', 'G0001', 1, 2, 3],
      ['getBluetooth', false],
      ['sendSequenceCommand', 'G0001', 'joke', null],
      ['updateListItem', 'l', 'i', { value: 'milk', completed: true, version: 2 }],
    ]);
  });

  it('deviceTimeZone reads the preferences the library attached at init, or undefined', async () => {
    const { client } = make();
    expect(await client.deviceTimeZone('G0001')).toBe('America/New_York');
    expect(await client.deviceTimeZone('G0002')).toBeUndefined();
  });

  it('createAlert builds the object with the library, then creates it; no id in the answer is a failure', async () => {
    const { client, remote } = make({ createNotification: (n: unknown) => ({ ...(n as object), id: 'n1' }) });
    const created = await client.createAlert({ serial: 'G0001', type: 'Reminder', label: 'x', timeMs: 123 });
    expect(created.id).toBe('n1');
    expect(remote.calls.map((c) => c.method)).toEqual(['createNotificationObject', 'createNotification']);
    const tweaked = await client.createAlert({ serial: 'G0001', type: 'Reminder', label: 'x', timeMs: 123, edit: (o) => ({ ...o, extra: 1 }) });
    expect(remote.calls.at(-1)?.args[0]).toMatchObject({ extra: 1 });
    expect(tweaked.id).toBe('n1');

    const { client: refusing } = make({ createNotification: () => null });
    await expect(refusing.createAlert({ serial: 'G0003', type: 'Reminder', label: 'x', timeMs: 1 })).rejects.toMatchObject({
      hint: expect.stringContaining('may not support reminders'),
    });
    await expect(refusing.createAlert({ serial: 'nope', type: 'Reminder', label: 'x', timeMs: 1 })).rejects.toThrow(/nope/);
  });

  it('deleteNotification passes the whole notification object', async () => {
    const { client, remote } = make();
    const n = { id: 'n1', type: 'Reminder' };
    await client.deleteNotification(n);
    expect(remote.calls.at(-1)).toEqual({ method: 'deleteNotification', args: [n] });
  });
});

describe('adoptRegistration (finishing a sign-in)', () => {
  it('makes an unconfigured client usable, persists the registration, and starts a fresh session', async () => {
    env.ALEXA_REGISTRATION = undefined;
    const { client, remote } = make({ getDevices: () => ({ devices: DEVICES }) });
    await expect(client.listDevices()).rejects.toThrow();
    await client.adoptRegistration({ ...REGISTRATION, loginCookie: 'adopted' });
    expect(client.describeConfig()).toMatchObject({ configured: true, source: 'state-file' });
    await client.listDevices();
    expect(remote.inits.at(-1)?.registration.loginCookie).toBe('adopted');
    expect(JSON.parse(readFileSync(registrationStatePath(env), 'utf8')).loginCookie).toBe('adopted');
  });

  it('replaces a live session rather than reusing the old account', async () => {
    const { client, remote } = make({ getDevices: () => ({ devices: DEVICES }) });
    await client.listDevices();
    await client.adoptRegistration({ ...REGISTRATION, deviceSerial: 'new-device', loginCookie: 'second' });
    await client.listDevices();
    expect(remote.inits).toHaveLength(2);
    expect(remote.session.stop).toHaveBeenCalled();
  });
});
