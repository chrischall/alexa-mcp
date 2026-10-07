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
