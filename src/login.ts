/**
 * `alexa-mcp login` — sign in from a terminal.
 *
 * The same browser sign-in the alexa_begin_login / alexa_finish_login tools
 * use (see browser-login.ts): it prints an amazon.com link, the user signs in
 * in their own browser, then pastes the address of the page they land on. The
 * registration is saved to the state file (0600). With `--print` it is also
 * written to stdout as one base64 line for ALEXA_REGISTRATION.
 *
 * The device shows up in the Amazon account's device list as "alexa-mcp";
 * removing it there revokes this server's access.
 */

import { createInterface } from 'node:readline/promises';
import { AlexaClient } from './client.js';
import type { Registration } from './registration.js';

export interface LoginOptions {
  amazonPage: string;
  print: boolean;
}

export function parseLoginArgs(argv: string[]): LoginOptions {
  const opts: LoginOptions = { amazonPage: 'amazon.com', print: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--print') opts.print = true;
    else if (arg === '--amazon-page') opts.amazonPage = String(argv[++i]);
    else if (arg === '--port') {
      // Retired in 0.2.0 (the sign-in moved to the user's own browser); accepted so old scripts keep working.
      i++;
      console.error('[alexa-mcp] --port is ignored: sign-in now happens in your own browser and needs no local port.');
    }
    else throw new Error(`Unknown option ${arg}. Usage: alexa-mcp login [--amazon-page amazon.com] [--print]`);
  }
  if (!/^amazon\.[a-z.]+$/.test(opts.amazonPage)) throw new Error('--amazon-page must look like amazon.com or amazon.co.uk.');
  return opts;
}

/** Base64 of the registration JSON: one line, safe to paste into a password field. */
export function encodeForPaste(registration: Registration): string {
  return Buffer.from(JSON.stringify(registration)).toString('base64');
}

/* v8 ignore start -- interactive: a human signs in to Amazon in a browser. */
export async function runLogin(argv: string[]): Promise<void> {
  const opts = parseLoginArgs(argv);
  const client = new AlexaClient({ env: { ...process.env, ALEXA_AMAZON_PAGE: opts.amazonPage } });
  const login = client.browserLogin();
  const { loginId, signInUrl, expiresInMinutes } = await login.begin();
  console.error('[alexa-mcp] 1. Open this link in your browser and sign in to Amazon:\n');
  console.error(`${signInUrl}\n`);
  console.error(
    '[alexa-mcp] 2. You will land on a blank www.amazon.com/ap/maplanding page. Copy its full address and ' +
      `paste it here (the link works for ${expiresInMinutes} minutes):`,
  );
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  const pasted = await rl.question('> ');
  rl.close();
  const registration = await login.finish(loginId, pasted);
  await client.adoptRegistration(registration);
  const devices = await client.listDevices();
  console.error(`[alexa-mcp] Signed in — ${devices.length} devices found. Saved to ${client.describeConfig().stateFile} (mode 0600).`);
  if (opts.print) {
    console.error('[alexa-mcp] The line below is a credential — paste it into ALEXA_REGISTRATION, never into a chat:');
    process.stdout.write(`${encodeForPaste(registration)}\n`);
  }
}
/* v8 ignore stop */
