/**
 * The Alexa "registration": a refresh token for a virtual Alexa-app device,
 * that device's serial, the `macDms` signing key, and the current session
 * cookies — the shape alexa-cookie2/alexa-remote2 use.
 *
 * It is the ONLY credential this server has. The browser sign-in
 * (browser-login.ts) happens once, by a human; after that the refresh token
 * mints fresh cookies server-side with no browser and no MFA. Cookies last ~14
 * days and are refreshed well before then, and every refresh produces an
 * updated registration that must be persisted — otherwise the next cold start
 * goes back to the stale cookie.
 *
 * Two sources:
 *   - the state file `$ALEXA_STATE_DIR/registration.json` (default
 *     `~/.alexa-mcp/`), written by every sign-in and every refresh;
 *   - `ALEXA_REGISTRATION` — the registration JSON (or base64 of it), the
 *     seed for a deployment configured from an exported registration.
 * When both are present, the one with the newer `tokenDate` wins, whatever
 * device each belongs to (a tie goes to the state file, the refreshed copy).
 * A re-login through alexa_finish_login registers a NEW device and writes the
 * state file, so it must beat an older env seed after a restart; a freshly
 * pasted env registration is newer than the old state file, so it wins too.
 */

import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { McpToolError, readEnvVar, writeFileSafe } from '@chrischall/mcp-utils';
import { z } from 'zod';

export type Env = Record<string, string | undefined>;

/** Loose: only the fields this server reads are checked; everything else rides along untouched. */
const registrationSchema = z
  .object({
    refreshToken: z.string().min(1),
    deviceSerial: z.string().min(1),
    amazonPage: z.string().optional(),
    tokenDate: z.number().optional(),
  })
  .passthrough();

export type Registration = z.infer<typeof registrationSchema>;

export interface LoadedRegistration {
  registration: Registration;
  /** Where it came from — a label, never the value. */
  source: 'env' | 'state-file';
}

export const LOGIN_HINT =
  'Sign in with alexa_begin_login → alexa_finish_login (or the connector sign-in, or `npx @chrischall/alexa-mcp ' +
  'login` in a terminal): you open an amazon.com link in your own browser, sign in, and paste back the address ' +
  'of the page you land on.';

/** Parse a registration from JSON or base64-encoded JSON. Errors name the source, never the content. */
export function parseRegistration(raw: string, source: string): Registration {
  const text = raw.trim();
  let value: unknown;
  try {
    value = JSON.parse(text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8'));
  } catch {
    throw new McpToolError(`${source} is not valid registration JSON (or base64 of it).`, { hint: LOGIN_HINT });
  }
  const parsed = registrationSchema.safeParse(value);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new McpToolError(`${source} is missing required registration fields: ${missing}.`, { hint: LOGIN_HINT });
  }
  return parsed.data;
}

export function registrationStatePath(env: Env = process.env): string {
  const dir = readEnvVar('ALEXA_STATE_DIR', { env }) ?? join(env.HOME ?? '', '.alexa-mcp');
  return join(dir, 'registration.json');
}

function readStateFile(path: string): Registration | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    return parseRegistration(raw, path);
  } catch {
    // A corrupt state file must not stop the server booting; the env seed (or a
    // fresh login) replaces it on the next save.
    console.error(`[alexa-mcp] Ignoring unreadable registration state file at ${path}.`);
    return null;
  }
}

export function loadRegistration(env: Env = process.env): LoadedRegistration | null {
  const rawEnv = env.ALEXA_REGISTRATION?.trim();
  const fromEnv = rawEnv ? parseRegistration(rawEnv, 'ALEXA_REGISTRATION') : null;
  const fromFile = readStateFile(registrationStatePath(env));

  if (fromEnv && fromFile) {
    return (fromFile.tokenDate ?? 0) >= (fromEnv.tokenDate ?? 0)
      ? { registration: fromFile, source: 'state-file' }
      : { registration: fromEnv, source: 'env' };
  }
  if (fromEnv) return { registration: fromEnv, source: 'env' };
  if (fromFile) return { registration: fromFile, source: 'state-file' };
  return null;
}

/** Persist (0600, directory 0700), replacing any previous save. */
export async function saveRegistration(path: string, registration: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileSafe(path, new TextEncoder().encode(JSON.stringify(registration)), { overwrite: true, mode: 0o600 });
}
