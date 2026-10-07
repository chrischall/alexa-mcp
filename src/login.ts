/**
 * `alexa-mcp login` — the one-time, human-in-the-loop sign-in.
 *
 * Amazon has no public API for this, so it uses alexa-cookie2's proxy login:
 * a local web server fronts Amazon's real sign-in page, the user signs in
 * there (password, 2FA, captcha — whatever Amazon asks), and the proxy
 * registers a virtual "Alexa app" device on the account and captures its
 * refresh token. That registration is saved to the state file (0600). With
 * `--print` it is also written to stdout as one base64 line, the value to
 * paste into a hosted connector's ALEXA_REGISTRATION field.
 *
 * The device shows up under Amazon → Manage Your Content and Devices; removing
 * it there revokes this server's access.
 */

import alexaCookie from 'alexa-cookie2';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type Registration, parseRegistration, registrationStatePath, saveRegistration } from './registration.js';

export interface LoginOptions {
  port: number;
  amazonPage: string;
  print: boolean;
}

export function parseLoginArgs(argv: string[]): LoginOptions {
  const opts: LoginOptions = { port: 3456, amazonPage: 'amazon.com', print: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--print') opts.print = true;
    else if (arg === '--port') opts.port = Number(argv[++i]);
    else if (arg === '--amazon-page') opts.amazonPage = String(argv[++i]);
    else throw new Error(`Unknown option ${arg}. Usage: alexa-mcp login [--port 3456] [--amazon-page amazon.com] [--print]`);
  }
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) throw new Error('--port must be a TCP port number.');
  if (!/^amazon\.[a-z.]+$/.test(opts.amazonPage)) throw new Error('--amazon-page must look like amazon.com or amazon.co.uk.');
  return opts;
}

/** Base64 of the registration JSON: one line, safe to paste into a password field. */
export function encodeForPaste(registration: Registration): string {
  return Buffer.from(JSON.stringify(registration)).toString('base64');
}

/* v8 ignore start -- drives a live browser sign-in; covered by hand, not by unit tests. */
export async function runLogin(argv: string[]): Promise<void> {
  const opts = parseLoginArgs(argv);
  const language = opts.amazonPage === 'amazon.com' ? 'en_US' : 'en_GB';
  const url = `http://127.0.0.1:${opts.port}/`;
  await mkdir(dirname(registrationStatePath()), { recursive: true, mode: 0o700 });
  console.error(`[alexa-mcp] Open ${url} in a desktop browser (one WITHOUT the Alexa app) and sign in to Amazon.`);
  const registration = await new Promise<Registration>((resolve, reject) => {
    alexaCookie.generateAlexaCookie(
      '',
      '',
      {
        proxyOnly: true,
        setupProxy: true,
        proxyOwnIp: '127.0.0.1',
        proxyPort: opts.port,
        proxyListenBind: '127.0.0.1',
        amazonPage: opts.amazonPage,
        baseAmazonPage: opts.amazonPage,
        amazonPageProxyLanguage: language,
        acceptLanguage: language.replace('_', '-'),
        deviceAppName: 'alexa-mcp',
        // Defaults to a file inside the library's own install dir (or beside the bundle); keep it with our state.
        formerDataStorePath: join(dirname(registrationStatePath()), 'proxy-device.json'),
        logger: () => {},
      },
      (err, result) => {
        // The first callback is the "please open the proxy URL" notice; the real result arrives after sign-in.
        if (!result) {
          if (err && !String((err as Error).message ?? err).includes('Please open')) reject(err);
          return;
        }
        try {
          resolve(parseRegistration(JSON.stringify(result), 'the sign-in result'));
        } catch (e) {
          reject(e);
        }
      },
    );
  });
  alexaCookie.stopProxyServer();
  const path = registrationStatePath();
  await saveRegistration(path, registration);
  console.error(`[alexa-mcp] Signed in. Registration saved to ${path} (mode 0600).`);
  if (opts.print) {
    console.error('[alexa-mcp] The line below is a credential — paste it into ALEXA_REGISTRATION, never into a chat:');
    process.stdout.write(`${encodeForPaste(registration)}\n`);
  }
}
/* v8 ignore stop */
