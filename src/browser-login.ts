/**
 * Sign in to Amazon in the user's OWN browser, then finish server-side.
 *
 * The user opens an ordinary amazon.com sign-in link and signs in there —
 * password, 2FA, captcha, whatever Amazon asks — with all of Amazon's own
 * checks running in their browser. Nothing here sees the password. When they
 * are done, Amazon redirects to `www.amazon.com/ap/maplanding?…`, a page that
 * shows nothing but whose ADDRESS carries a one-time authorization code; the
 * user pastes that address back.
 *
 * The link is the Alexa iOS app's OAuth 2 sign-in with PKCE: `begin()` mints a
 * virtual device id and a code verifier, keeps the verifier on disk (0600), and
 * sends only its SHA-256 challenge in the link. `finish()` exchanges the code +
 * verifier at `api.amazon.com/auth/register` for a refresh token, a signing key
 * (`mac_dms`) and website cookies, then hands them to alexa-cookie2's refresh to
 * mint the local cookies and CSRF token alexa-remote2 needs. A pasted code is
 * useless without the verifier, which never leaves this machine.
 *
 * Verified live 2026-10-07: link → phone sign-in → paste → register 200 → refresh
 * → getDevices returned the account's devices.
 */

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { McpToolError, writeFileSafe } from '@chrischall/mcp-utils';
import type { Registration } from './registration.js';

/** How long a sign-in link stays redeemable. Amazon's codes expire in minutes; this bounds the pending store. */
export const LOGIN_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING = 5;
const APP_VERSION = '2.2.651540.0';
const API_USER_AGENT = `AmazonWebView/Amazon Alexa/${APP_VERSION}/iOS/18.3.1/iPhone`;
export const DEVICE_APP_NAME = 'alexa-mcp';

const RESTART_HINT = 'Start again with alexa_begin_login (or the connector sign-in) for a fresh link.';

interface PendingLogin {
  deviceId: string;
  verifier: string;
  createdAt: number;
}

export interface BrowserLoginOptions {
  stateDir: string;
  amazonPage: string;
  fetchImpl?: typeof fetch;
  /** Mint local cookies + CSRF from the token seed (alexa-cookie2 refresh). */
  complete: (seed: Registration) => Promise<Registration>;
  now?: () => number;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

/** Pull the authorization code out of a pasted maplanding address (or accept a bare code). */
export function parseAuthorizationCode(pasted: string): string {
  const text = pasted.trim();
  if (/^[A-Za-z0-9]{12,128}$/.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new McpToolError('That is not the address of the Amazon page you landed on.', {
      hint: 'After signing in, copy the full address of the www.amazon.com/ap/maplanding page and paste it.',
    });
  }
  if (url.protocol !== 'https:' || !/(^|\.)amazon\.[a-z.]+$/.test(url.hostname)) {
    throw new McpToolError(`That address is on ${url.hostname}, not Amazon.`, {
      hint: 'Paste the address of the www.amazon.com/ap/maplanding page Amazon sent you to after signing in.',
    });
  }
  const code = url.searchParams.get('openid.oa2.authorization_code');
  if (!code) {
    throw new McpToolError('That Amazon address has no sign-in code in it — paste the www.amazon.com/ap/maplanding address you land on after signing in.', {
      hint: 'Finish signing in first; the address to paste is the www.amazon.com/ap/maplanding?… page you end up on.',
    });
  }
  return code;
}

export class BrowserLogin {
  private readonly pendingPath: string;
  private readonly seedPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: BrowserLoginOptions) {
    this.pendingPath = join(opts.stateDir, 'pending-logins.json');
    this.seedPath = join(opts.stateDir, 'registration-seed.json');
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
  }

  private readPending(): Record<string, PendingLogin> {
    try {
      return JSON.parse(readFileSync(this.pendingPath, 'utf8')) as Record<string, PendingLogin>;
    } catch {
      return {};
    }
  }

  private async writePending(all: Record<string, PendingLogin>): Promise<void> {
    await mkdir(this.opts.stateDir, { recursive: true, mode: 0o700 });
    await writeFileSafe(this.pendingPath, new TextEncoder().encode(JSON.stringify(all)), { overwrite: true, mode: 0o600 });
  }

  /** Mint a sign-in link. Returns the link and the handle `finish` needs. */
  async begin(): Promise<{ loginId: string; signInUrl: string; expiresInMinutes: number }> {
    const deviceId = Buffer.from(crypto.randomBytes(16).toString('hex').toUpperCase()).toString('hex') + '23413249564c5635564d32573831';
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const loginId = crypto.randomBytes(12).toString('hex');

    const now = this.now();
    const live = Object.entries(this.readPending())
      .filter(([, p]) => now - p.createdAt < LOGIN_TTL_MS)
      .sort(([, a], [, b]) => b.createdAt - a.createdAt)
      .slice(0, MAX_PENDING - 1);
    await this.writePending({ ...Object.fromEntries(live), [loginId]: { deviceId, verifier, createdAt: now } });

    const page = this.opts.amazonPage;
    const q = new URLSearchParams({
      'openid.return_to': `https://www.${page}/ap/maplanding`,
      'openid.assoc_handle': 'amzn_dp_project_dee_ios',
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
      pageId: 'amzn_dp_project_dee_ios',
      accountStatusPolicy: 'P1',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.mode': 'checkid_setup',
      'openid.ns.oa2': `http://www.${page}/ap/ext/oauth/2`,
      'openid.oa2.client_id': `device:${deviceId}`,
      'openid.ns.pape': 'http://specs.openid.net/extensions/pape/1.0',
      'openid.oa2.response_type': 'code',
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.pape.max_auth_age': '0',
      'openid.oa2.scope': 'device_auth_access',
      'openid.oa2.code_challenge_method': 'S256',
      'openid.oa2.code_challenge': challenge,
      language: 'en_US',
    });
    return { loginId, signInUrl: `https://www.${page}/ap/signin?${q}`, expiresInMinutes: LOGIN_TTL_MS / 60_000 };
  }

  /** Redeem a pasted maplanding address for a full registration. Single-use per login id. */
  async finish(loginId: string, pasted: string): Promise<Registration> {
    const code = parseAuthorizationCode(pasted);
    const all = this.readPending();
    const pending = all[loginId];
    if (!pending || this.now() - pending.createdAt >= LOGIN_TTL_MS) {
      throw new McpToolError('That sign-in link has expired or was already used — start again for a fresh link.', { hint: RESTART_HINT });
    }
    // Spend the login id before calling Amazon: a code is single-use, so a second attempt could only fail.
    delete all[loginId];
    await this.writePending(all);

    const page = this.opts.amazonPage;
    const deviceSerial = crypto.randomBytes(16).toString('hex');
    const frc = crypto.randomBytes(313).toString('base64');
    const res = await this.fetchImpl(`https://api.${page}/auth/register`, {
      method: 'POST',
      headers: {
        'User-Agent': API_USER_AGENT,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Language': 'en-US',
        'x-amzn-identity-auth-domain': `api.${page}`,
      },
      body: JSON.stringify({
        requested_extensions: ['device_info', 'customer_info'],
        cookies: { website_cookies: [], domain: `.${page}` },
        registration_data: {
          domain: 'Device',
          app_version: APP_VERSION,
          device_type: 'A2IVLV5VM2W81',
          device_name: `%FIRST_NAME%'s%DUPE_STRATEGY_1ST%${DEVICE_APP_NAME}`,
          os_version: '18.3.1',
          device_serial: deviceSerial,
          device_model: 'iPhone',
          app_name: DEVICE_APP_NAME,
          software_version: '1',
        },
        auth_data: {
          client_id: pending.deviceId,
          authorization_code: code,
          code_verifier: pending.verifier,
          code_algorithm: 'SHA-256',
          client_domain: 'DeviceLegacy',
        },
        user_context_map: { frc },
        requested_token_type: ['bearer', 'mac_dms', 'website_cookies'],
      }),
    });
    const body = (await res.json().catch(() => null)) as {
      response?: {
        success?: { tokens?: { bearer?: { refresh_token?: string; access_token?: string }; mac_dms?: unknown; website_cookies?: { Name: string; Value: string }[] } };
        error?: { code?: string };
      };
    } | null;
    const tokens = body?.response?.success?.tokens;
    if (!res.ok || !tokens?.bearer?.refresh_token) {
      // Amazon's error CODE only — the body can echo request values.
      const reason = body?.response?.error?.code ?? `HTTP ${res.status}`;
      throw new McpToolError(`Amazon did not accept the sign-in code (${reason}).`, {
        hint: `Codes are single-use and expire within minutes. ${RESTART_HINT}`,
      });
    }

    const seed: Registration = {
      deviceId: pending.deviceId,
      deviceSerial,
      deviceAppName: DEVICE_APP_NAME,
      frc,
      'map-md': Buffer.from(
        `{"device_user_dictionary":[],"device_registration_data":{"software_version":"1"},"app_identifier":{"app_version":"${APP_VERSION}","bundle_id":"com.amazon.echo"}}`,
      ).toString('base64'),
      refreshToken: tokens.bearer.refresh_token,
      accessToken: tokens.bearer.access_token,
      macDms: tokens.mac_dms,
      amazonPage: page,
      tokenDate: this.now(),
      loginCookie: (tokens.website_cookies ?? []).map((c) => `${c.Name}=${c.Value}`).join('; '),
    };
    // Persist the token seed BEFORE anything else can fail: the refresh token is the whole result,
    // and losing it means a new sign-in (and another orphaned device on the account).
    await writeFileSafe(this.seedPath, new TextEncoder().encode(JSON.stringify(seed)), { overwrite: true, mode: 0o600 });
    const full = await this.opts.complete(seed);
    return { ...seed, ...full };
  }
}
