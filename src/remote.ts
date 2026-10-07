/**
 * The seam between this server and `alexa-remote2`.
 *
 * `alexa-remote2` is callback-based, keeps its session in instance state, and
 * talks to Amazon's private Alexa web API (the one the Alexa app uses). This
 * module promisifies the handful of methods the tools need and hides the
 * library behind {@link RemoteSession}, so `client.ts` and every test work
 * against a small structural interface rather than the library itself.
 *
 * Two library behaviours are pinned here deliberately:
 *
 *  - `cookieRefreshInterval: 0` turns OFF the library's own refresh timer. That
 *    timer re-invokes `init()`'s callback on every refresh, which would resolve
 *    an already-settled promise and race the client's single-flight. The client
 *    refreshes explicitly instead (see `client.ts`).
 *  - The push connection (`usePushConnection`/`useWsMqtt`) stays off: a
 *    scale-to-zero host would hold it open for nothing, and no tool reads
 *    pushed events.
 */

import AlexaRemote from 'alexa-remote2';
import alexaCookie from 'alexa-cookie2';
import type { Registration } from './registration.js';

/** The subset of a device record from `getDevices` that this server reads. */
export interface RawDevice {
  accountName?: string;
  serialNumber: string;
  deviceType?: string;
  deviceFamily?: string;
  online?: boolean;
  capabilities?: string[];
  softwareVersion?: string;
  [key: string]: unknown;
}

export interface RemoteSession {
  /** Devices known to the session, keyed by serial — populated by `init`. */
  readonly devices: () => RawDevice[];
  /** Invoke a callback-style library method; resolves with its body. */
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  /** Tear down (clears library timers). */
  stop(): void;
}

export interface RemoteInit {
  registration: Registration;
  amazonPage: string;
  acceptLanguage: string;
  /** Called with the full updated registration whenever the library mints new cookies. */
  onRegistration: (registration: Registration) => void;
}

export type RemoteFactory = (init: RemoteInit) => Promise<RemoteSession>;

/**
 * The API user-agent suffix alexa-remote2 would otherwise compute with
 * `require(path.join(__dirname, 'package.json'))` — which throws inside the
 * esbuild bundle (no package.json beside it). Passed explicitly; a test pins it
 * to the installed library version so a dependency bump can't leave it stale.
 */
export const API_USER_AGENT_POSTFIX = 'AlexaRemote/8.1.1';

/** Mint fresh cookies from the refresh token. Resolves the updated registration. */
export type Refresher = (registration: Registration, amazonPage: string) => Promise<Registration>;

/** Library errors arrive as Error, string, string[] or `{message}`; normalise to Error. */
export function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (Array.isArray(err)) return new Error(err.map(String).join('; '));
  if (err && typeof err === 'object' && 'message' in err) return new Error(String((err as { message: unknown }).message));
  return new Error(String(err));
}

/* v8 ignore start -- the live library: exercised by scripts/live-check.mjs, never by unit tests (no network). */
export const createAlexaRemote: RemoteFactory = (init) =>
  new Promise((resolve, reject) => {
    const remote = new AlexaRemote();
    let settled = false;
    remote.on('cookie', () => {
      const data = (remote as unknown as { cookieData?: unknown }).cookieData;
      if (data && typeof data === 'object') init.onRegistration(data as Registration);
    });
    remote.init(
      {
        cookie: init.registration,
        formerRegistrationData: init.registration,
        macDms: init.registration.macDms,
        amazonPage: init.amazonPage,
        acceptLanguage: init.acceptLanguage,
        useWsMqtt: false,
        usePushConnection: false,
        cookieRefreshInterval: 0,
        apiUserAgentPostfix: API_USER_AGENT_POSTFIX,
        // The library logs cookies at debug level; never pass a logger that writes them anywhere.
        logger: () => {},
      } as never,
      (err?: unknown) => {
        if (settled) return;
        settled = true;
        if (err) {
          remote.stop();
          reject(toError(err));
          return;
        }
        const lib = remote as unknown as Record<string, (...a: unknown[]) => void> & {
          serialNumbers?: Record<string, RawDevice>;
        };
        resolve({
          devices: () => Object.values(lib.serialNumbers ?? {}),
          call: <T>(method: string, ...args: unknown[]) =>
            new Promise<T>((res, rej) => {
              const fn = lib[method];
              if (typeof fn !== 'function') {
                rej(new Error(`alexa-remote2 has no method ${method}`));
                return;
              }
              fn.call(remote, ...args, (e: unknown, body: T) => (e ? rej(toError(e)) : res(body)));
            }),
          stop: () => remote.stop(),
        });
      },
    );
  });

export const refreshWithCookieLib: Refresher = (registration, amazonPage) =>
  new Promise((resolve, reject) => {
    alexaCookie.refreshAlexaCookie(
      { formerRegistrationData: registration, amazonPage, logger: () => {} },
      (err: unknown, result: unknown) => (err ? reject(toError(err)) : resolve(result as Registration)),
    );
  });
/* v8 ignore stop */
