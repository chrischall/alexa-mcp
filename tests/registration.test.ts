import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadRegistration,
  parseRegistration,
  registrationStatePath,
  saveRegistration,
} from '../src/registration.js';

const REG = { refreshToken: 'Atnr|secret-refresh', deviceSerial: 'serial-1', macDms: { device_private_key: 'k' }, amazonPage: 'amazon.com', tokenDate: 1000 };

describe('parseRegistration', () => {
  it('accepts a JSON object string', () => {
    expect(parseRegistration(JSON.stringify(REG), 'ALEXA_REGISTRATION').deviceSerial).toBe('serial-1');
  });

  it('accepts base64-encoded JSON (survives single-line paste fields)', () => {
    const b64 = Buffer.from(JSON.stringify(REG)).toString('base64');
    expect(parseRegistration(b64, 'ALEXA_REGISTRATION').refreshToken).toBe(REG.refreshToken);
  });

  it('rejects data without a refresh token, naming the source but never echoing the value', () => {
    const raw = JSON.stringify({ deviceSerial: 'x', loginCookie: 'very-secret-cookie' });
    let thrown: unknown;
    try {
      parseRegistration(raw, 'ALEXA_REGISTRATION');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error & { hint?: string };
    expect(err.message).toContain('ALEXA_REGISTRATION');
    expect(err.message).not.toContain('very-secret-cookie');
    expect(err.hint).toContain('alexa-mcp login');
  });

  it('rejects garbage that is neither JSON nor base64 JSON', () => {
    expect(() => parseRegistration('not a registration', 'ALEXA_REGISTRATION')).toThrow(/ALEXA_REGISTRATION/);
  });
});

describe('registrationStatePath', () => {
  it('defaults to ~/.alexa-mcp/registration.json', () => {
    expect(registrationStatePath({ HOME: '/home/u' })).toBe('/home/u/.alexa-mcp/registration.json');
  });

  it('honours ALEXA_STATE_DIR', () => {
    expect(registrationStatePath({ HOME: '/home/u', ALEXA_STATE_DIR: '/data/alexa' })).toBe('/data/alexa/registration.json');
  });
});

describe('loadRegistration / saveRegistration', () => {
  let dir: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'alexa-reg-'));
    env = { HOME: dir, ALEXA_STATE_DIR: dir };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns null when nothing is configured', () => {
    expect(loadRegistration(env)).toBeNull();
  });

  it('reads ALEXA_REGISTRATION when no state file exists', () => {
    env.ALEXA_REGISTRATION = JSON.stringify(REG);
    expect(loadRegistration(env)).toMatchObject({ source: 'env', registration: { deviceSerial: 'serial-1' } });
  });

  it('reads the state file when no env var is set', async () => {
    await saveRegistration(registrationStatePath(env), REG);
    expect(loadRegistration(env)).toMatchObject({ source: 'state-file' });
  });

  it('prefers a REFRESHED state file for the same device over the env seed', async () => {
    env.ALEXA_REGISTRATION = JSON.stringify(REG);
    await saveRegistration(registrationStatePath(env), { ...REG, tokenDate: 2000, loginCookie: 'newer' });
    const loaded = loadRegistration(env);
    expect(loaded?.source).toBe('state-file');
    expect(loaded?.registration.loginCookie).toBe('newer');
  });

  it('newer tokenDate wins regardless of device: a re-login saved to the state file beats an older env seed', async () => {
    // alexa_finish_login registered a NEW device and wrote the state file; the env still holds the old seed.
    env.ALEXA_REGISTRATION = JSON.stringify({ ...REG, tokenDate: 1000 });
    await saveRegistration(registrationStatePath(env), { ...REG, deviceSerial: 'serial-2', tokenDate: 9999 });
    expect(loadRegistration(env)).toMatchObject({ source: 'state-file', registration: { deviceSerial: 'serial-2' } });
  });

  it('newer tokenDate wins regardless of device: a freshly pasted env registration beats an older state file', async () => {
    env.ALEXA_REGISTRATION = JSON.stringify({ ...REG, deviceSerial: 'serial-2', tokenDate: 9999 });
    await saveRegistration(registrationStatePath(env), { ...REG, tokenDate: 1000 });
    expect(loadRegistration(env)).toMatchObject({ source: 'env', registration: { deviceSerial: 'serial-2' } });
  });

  it('an older state file for the same device loses to the env seed', async () => {
    env.ALEXA_REGISTRATION = JSON.stringify({ ...REG, tokenDate: 5000, loginCookie: 'env' });
    await saveRegistration(registrationStatePath(env), { ...REG, tokenDate: 4000, loginCookie: 'file' });
    expect(loadRegistration(env)).toMatchObject({ source: 'env', registration: { loginCookie: 'env' } });
  });

  it('treats a corrupt state file as absent rather than failing boot', () => {
    writeFileSync(registrationStatePath(env), '{nope');
    env.ALEXA_REGISTRATION = JSON.stringify(REG);
    expect(loadRegistration(env)?.source).toBe('env');
  });

  it('saves with 0600 permissions and overwrites a previous save', async () => {
    const path = registrationStatePath(env);
    await saveRegistration(path, REG);
    await saveRegistration(path, { ...REG, tokenDate: 5 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8')).tokenDate).toBe(5);
  });

  it('creates a missing state directory', async () => {
    const path = join(dir, 'nested', 'deeper', 'registration.json');
    await saveRegistration(path, REG);
    expect(JSON.parse(readFileSync(path, 'utf8')).deviceSerial).toBe('serial-1');
  });
});
