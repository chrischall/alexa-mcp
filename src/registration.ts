/**
 * The Alexa "registration" — the object `alexa-cookie2` returns from its proxy
 * login: a refresh token for a virtual Alexa-app device, that device's serial,
 * the `macDms` signing key, and the current session cookies.
 *
 * It is the ONLY credential this server has. The proxy login (`alexa-mcp
 * login`) happens once, by a human, in a browser; after that the refresh token
 * mints fresh cookies server-side with no browser and no MFA. Cookies last ~14
 * days and are refreshed well before then, and every refresh produces an
 * updated registration that must be persisted — otherwise the next cold start
 * goes back to the stale cookie.
 *
 * Two sources, in this precedence:
 *   1. the state file `$ALEXA_STATE_DIR/registration.json` (default
 *      `~/.alexa-mcp/`), written by `alexa-mcp login` and by every refresh —
 *      but only when it belongs to the SAME virtual device as (1b) and is at
 *      least as new;
 *   1b. `ALEXA_REGISTRATION` — the registration JSON (or base64 of it), the
 *      seed for a hosted deployment where no one can run the login.
 * A state file for a different device loses to the env var: that is what a
 * fresh `alexa-mcp login` pasted into the env looks like.
 */

import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { McpToolError, writeFileSafe } from '@chrischall/mcp-utils';
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
  'Run `npx @chrischall/alexa-mcp login` on a computer with a browser, sign in to Amazon through the ' +
  'local page it opens, then either keep the saved state file or paste the printed registration into ' +
  'ALEXA_REGISTRATION.';

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
  const dir = env.ALEXA_STATE_DIR?.trim() || join(env.HOME ?? '', '.alexa-mcp');
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
    const sameDevice = fromFile.deviceSerial === fromEnv.deviceSerial;
    const atLeastAsNew = (fromFile.tokenDate ?? 0) >= (fromEnv.tokenDate ?? 0);
    return sameDevice && atLeastAsNew
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
