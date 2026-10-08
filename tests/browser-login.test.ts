import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import {
  BrowserLogin,
  LOGIN_TTL_MS,
  parseAuthorizationCode,
} from '../src/browser-login.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alexa-browser-login-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const REGISTER_OK = {
  response: {
    success: {
      tokens: {
        bearer: { refresh_token: 'Atnr|refresh', access_token: 'Atna|access' },
        mac_dms: { device_private_key: 'k', adp_token: 't' },
        website_cookies: [
          { Name: 'session-id', Value: 's1' },
          { Name: 'at-main', Value: 'a1' },
        ],
      },
    },
  },
};

function make(opts: { fetchBody?: unknown; status?: number; now?: () => number } = {}) {
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(opts.fetchBody ?? REGISTER_OK), { status: opts.status ?? 200 }),
  );
  const complete = vi.fn(async (seed: Record<string, unknown>) => ({ ...seed, localCookie: 'csrf=x', csrf: 'x' }));
  const login = new BrowserLogin({
    stateDir: dir,
    amazonPage: 'amazon.com',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    complete,
    now: opts.now,
  });
  return { login, fetchImpl, complete };
}

describe('parseAuthorizationCode', () => {
  it('reads the code out of a pasted maplanding address', () => {
    expect(parseAuthorizationCode('https://www.amazon.com/ap/maplanding?openid.mode=id_res&openid.oa2.authorization_code=ANKtozCuviktRHMJ&x=1')).toBe('ANKtozCuviktRHMJ');
  });

  it('accepts surrounding whitespace and a bare code', () => {
    expect(parseAuthorizationCode('  ANklqRAcZUpKpQgwHpJxVAQZ \n')).toBe('ANklqRAcZUpKpQgwHpJxVAQZ');
  });

  it('refuses an address with no code, naming what to paste', () => {
    expect(() => parseAuthorizationCode('https://www.amazon.com/ap/signin?foo=1')).toThrow(/maplanding/);
  });

  it('refuses a non-Amazon address carrying a code (only Amazon issues these)', () => {
    expect(() => parseAuthorizationCode('https://evil.example/ap/maplanding?openid.oa2.authorization_code=ANKtozCuviktRHMJ')).toThrow(/amazon/i);
  });
});

describe('BrowserLogin.begin', () => {
  it('returns an Amazon sign-in link with a PKCE challenge for the Alexa app client', async () => {
    const { login } = make();
    const { loginId, signInUrl } = await login.begin();
    const url = new URL(signInUrl);
    expect(url.origin).toBe('https://www.amazon.com');
    expect(url.pathname).toBe('/ap/signin');
    expect(url.searchParams.get('openid.return_to')).toBe('https://www.amazon.com/ap/maplanding');
    expect(url.searchParams.get('openid.assoc_handle')).toBe('amzn_dp_project_dee_ios');
    expect(url.searchParams.get('openid.oa2.code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('openid.oa2.client_id')).toMatch(/^device:[0-9a-f]+$/);
    expect(loginId).toMatch(/^[0-9a-f]{16,}$/);
  });

  it('keeps the verifier out of the link and on disk (0600) for the finish step', async () => {
    const { login } = make();
    const { signInUrl } = await login.begin();
    const file = join(dir, 'pending-logins.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const pending = Object.values(JSON.parse(readFileSync(file, 'utf8')))[0] as { verifier: string };
    const challenge = crypto.createHash('sha256').update(pending.verifier).digest('base64url');
    expect(new URL(signInUrl).searchParams.get('openid.oa2.code_challenge')).toBe(challenge);
    expect(signInUrl).not.toContain(pending.verifier);
  });
});

describe('BrowserLogin.finish', () => {
  const pasted = (code = 'ANklqRAcZUpKpQgwHpJxVAQZ') => `https://www.amazon.com/ap/maplanding?openid.oa2.authorization_code=${code}`;

  it('exchanges the code with the matching verifier and device id, then completes the registration', async () => {
    const { login, fetchImpl, complete } = make();
    const { loginId } = await login.begin();
    const pending = Object.values(JSON.parse(readFileSync(join(dir, 'pending-logins.json'), 'utf8')))[0] as { verifier: string; deviceId: string };
    const reg = await login.finish(loginId, pasted());
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.amazon.com/auth/register');
    const body = JSON.parse(String(init?.body));
    expect(body.auth_data).toEqual({
      client_id: pending.deviceId,
      authorization_code: 'ANklqRAcZUpKpQgwHpJxVAQZ',
      code_verifier: pending.verifier,
      code_algorithm: 'SHA-256',
      client_domain: 'DeviceLegacy',
    });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: 'Atnr|refresh', loginCookie: 'session-id=s1; at-main=a1' }));
    expect(reg).toMatchObject({ refreshToken: 'Atnr|refresh', deviceId: pending.deviceId, csrf: 'x', amazonPage: 'amazon.com' });
  });

  it('saves the token seed BEFORE completing, so a failed completion does not lose the device', async () => {
    const { login, complete } = make();
    complete.mockRejectedValueOnce(new Error('exchange down'));
    const { loginId } = await login.begin();
    await expect(login.finish(loginId, pasted())).rejects.toThrow(/exchange down/);
    const seed = JSON.parse(readFileSync(join(dir, 'registration-seed.json'), 'utf8'));
    expect(seed.refreshToken).toBe('Atnr|refresh');
    expect(statSync(join(dir, 'registration-seed.json')).mode & 0o777).toBe(0o600);
  });

  it('a login id is single-use', async () => {
    const { login } = make();
    const { loginId } = await login.begin();
    await login.finish(loginId, pasted());
    await expect(login.finish(loginId, pasted())).rejects.toThrow(/start again/i);
  });

  it('an unknown or expired login id asks to start again, without calling Amazon', async () => {
    let t = 1_000_000;
    const { login, fetchImpl } = make({ now: () => t });
    const { loginId } = await login.begin();
    t += LOGIN_TTL_MS + 1;
    await expect(login.finish(loginId, pasted())).rejects.toThrow(/start again/i);
    await expect(login.finish('deadbeefdeadbeef', pasted())).rejects.toThrow(/start again/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports Amazon refusing the code (expired / already used) as a restart, not a retry', async () => {
    const { login } = make({ status: 400, fetchBody: { response: { error: { code: 'InvalidValue', message: 'authorization code expired' } } } });
    const { loginId } = await login.begin();
    await expect(login.finish(loginId, pasted())).rejects.toMatchObject({
      message: expect.stringContaining('InvalidValue'),
      hint: expect.stringMatching(/start again/i),
    });
  });

  it('never echoes the code or tokens in an error', async () => {
    const { login } = make({ status: 500, fetchBody: { oops: 'Atnr|leak' } });
    const { loginId } = await login.begin();
    const err = (await login.finish(loginId, pasted('ANsecretCode123456')).catch((e: Error) => e)) as Error & { hint?: string };
    expect(`${err.message} ${err.hint}`).not.toContain('ANsecretCode123456');
    expect(`${err.message} ${err.hint}`).not.toContain('Atnr|leak');
  });
});
