/**
 * `AlexaClient` — the one object every tool talks to.
 *
 * Deferred-config pattern: the constructor does no I/O and never throws, so the
 * server boots and answers `tools/list` with no Alexa registration present. A
 * missing or malformed registration is stored as `configError` and thrown from
 * the first call that needs the network.
 *
 * Session lifecycle:
 *  - ONE `RemoteSession` per process, created lazily and single-flight: three
 *    concurrent tool calls cause one `init`, not three.
 *  - Before `init`, a registration whose cookies are older than
 *    {@link REFRESH_AFTER_MS} is refreshed from its refresh token (no browser,
 *    no MFA) and the result persisted. A failed refresh is not fatal — the
 *    existing cookie is good for ~14 days and the library re-authenticates from
 *    the refresh token on its own if the cookie turns out to be dead.
 *  - Every registration the library mints mid-session is persisted to the
 *    state file, so the next cold start begins from the newest cookie.
 *  - An auth-shaped failure drops the session; the next call re-initialises.
 */

import { dirname } from 'node:path';
import { BrowserLogin } from './browser-login.js';
import { McpToolError, readEnvVar } from '@chrischall/mcp-utils';
import {
  type Env,
  LOGIN_HINT,
  type LoadedRegistration,
  type Registration,
  loadRegistration,
  registrationStatePath,
  saveRegistration,
} from './registration.js';
import {
  type RawDevice,
  type Refresher,
  type RemoteFactory,
  type RemoteSession,
  createAlexaRemote,
  refreshWithCookieLib,
} from './remote.js';

/** Refresh cookies once they are this old. They last ~14 days; alexa-cookie2 recommends 5–13. */
export const REFRESH_AFTER_MS = 4 * 24 * 60 * 60 * 1000;

const AUTH_FAILURE = /\b401\b|unauthori[sz]ed|not authenticated|no csrf|authentication/i;

export type SmartHomeEntityType = 'APPLIANCE' | 'GROUP';
export type PlaybackCommand = 'play' | 'pause' | 'next' | 'previous';

export interface AlexaClientOptions {
  env?: Env;
  factory?: RemoteFactory;
  refresh?: Refresher;
  now?: () => number;
  /** For the sign-in exchange with api.amazon.com (tests). */
  fetchImpl?: typeof fetch;
}

export interface ConfigDescription {
  configured: boolean;
  /** `env` / `state-file` — a label, never the value. */
  source: LoadedRegistration['source'] | null;
  amazonPage: string;
  /** Age of the current cookies in hours, when known. */
  cookieAgeHours: number | null;
  stateFile: string;
}

export class AlexaClient {
  private readonly env: Env;
  private readonly factory: RemoteFactory;
  private readonly refresh: Refresher;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly statePath: string;
  private loaded: LoadedRegistration | null = null;
  private configError: Error | null = null;
  private session: Promise<RemoteSession> | null = null;
  private persisting: Promise<void> = Promise.resolve();

  constructor(opts: AlexaClientOptions = {}) {
    this.env = opts.env ?? process.env;
    this.factory = opts.factory ?? createAlexaRemote;
    this.refresh = opts.refresh ?? refreshWithCookieLib;
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetchImpl;
    this.statePath = registrationStatePath(this.env);
    try {
      this.loaded = loadRegistration(this.env);
      if (!this.loaded) {
        this.configError = new McpToolError('No Alexa registration is configured.', { hint: LOGIN_HINT });
      }
    } catch (err) {
      this.configError = err as Error;
    }
  }

  get amazonPage(): string {
    return readEnvVar('ALEXA_AMAZON_PAGE', { env: this.env }) ?? this.loaded?.registration.amazonPage ?? 'amazon.com';
  }

  describeConfig(): ConfigDescription {
    const tokenDate = this.loaded?.registration.tokenDate;
    return {
      configured: this.loaded !== null,
      source: this.loaded?.source ?? null,
      amazonPage: this.amazonPage,
      cookieAgeHours: tokenDate === undefined ? null : Math.round(((this.now() - tokenDate) / 3_600_000) * 10) / 10,
      stateFile: this.statePath,
    };
  }

  /** The directory the registration (and pending sign-ins) live in. */
  get stateDir(): string {
    return dirname(this.statePath);
  }

  /**
   * Take on a registration from a just-finished sign-in: persist it, clear any
   * "not configured" error, and drop the current session so the next call
   * starts on the new account. Awaits the save — a sign-in whose result was
   * not written would be lost on the next cold start.
   */
  async adoptRegistration(registration: Registration): Promise<void> {
    await this.persisting;
    await saveRegistration(this.statePath, registration);
    this.loaded = { registration, source: 'state-file' };
    this.configError = null;
    this.dropSession();
  }

  /** A browser sign-in bound to this client's state dir, Amazon site and refresher. */
  browserLogin(): BrowserLogin {
    return new BrowserLogin({
      stateDir: this.stateDir,
      amazonPage: this.amazonPage,
      fetchImpl: this.fetchImpl,
      now: this.now,
      complete: (seed) => this.refresh(seed, this.amazonPage),
    });
  }

  /** Resolves once every queued state-file write has settled. */
  flushPersistence(): Promise<void> {
    return this.persisting;
  }

  private persist(registration: Registration): void {
    if (this.loaded) this.loaded = { ...this.loaded, registration };
    this.persisting = this.persisting
      .then(() => saveRegistration(this.statePath, registration))
      .catch((err: unknown) => {
        // Losing a save costs a refresh on the next cold start, nothing more — never fail a tool call for it.
        console.error(`[alexa-mcp] Could not save the refreshed registration to ${this.statePath}: ${(err as Error).message}`);
      });
  }

  private async start(): Promise<RemoteSession> {
    if (this.configError || !this.loaded) throw this.configError;
    let registration = this.loaded.registration;
    if (this.now() - (registration.tokenDate ?? 0) > REFRESH_AFTER_MS) {
      try {
        registration = await this.refresh(registration, this.amazonPage);
        this.persist(registration);
      } catch (err) {
        console.error(`[alexa-mcp] Cookie refresh failed (${(err as Error).message}); trying the existing cookie.`);
      }
    }
    return this.factory({
      registration,
      amazonPage: this.amazonPage,
      acceptLanguage: readEnvVar('ALEXA_ACCEPT_LANGUAGE', { env: this.env }) ?? 'en-US',
      onRegistration: (next) => this.persist(next),
    });
  }

  private ensure(): Promise<RemoteSession> {
    if (!this.session) {
      const pending = this.start();
      this.session = pending;
      pending.catch(() => {
        if (this.session === pending) this.session = null;
      });
    }
    return this.session;
  }

  private dropSession(): void {
    const current = this.session;
    this.session = null;
    current?.then((s) => s.stop()).catch(() => {});
  }

  /** Run one library call, translating auth failures into an actionable error. */
  private async call<T>(method: string, ...args: unknown[]): Promise<T> {
    const session = await this.ensure();
    try {
      return await session.call<T>(method, ...args);
    } catch (err) {
      const message = (err as Error).message;
      if (AUTH_FAILURE.test(message)) {
        this.dropSession();
        throw new McpToolError(`Amazon rejected the Alexa session (${message}).`, {
          hint:
            'The next call re-authenticates from the refresh token automatically. If this keeps happening, the ' +
            'registration was revoked (password change, or the "alexa-mcp" device removed from your Amazon ' +
            `account) and you need to be signed in again. ${LOGIN_HINT}`,
          cause: err,
        });
      }
      throw new McpToolError(`Alexa ${method} failed: ${message}`, { cause: err });
    }
  }

  // ---------------------------------------------------------------- devices

  async listDevices(): Promise<RawDevice[]> {
    const body = await this.call<{ devices?: RawDevice[] }>('getDevices');
    const own = this.loaded?.registration.deviceSerial;
    return (body.devices ?? []).filter((d) => d.serialNumber !== own);
  }

  /** Find a device by serial number, exact name, or unique name substring (case-insensitive). */
  async resolveDevice(nameOrSerial: string): Promise<RawDevice> {
    const devices = await this.listDevices();
    const wanted = nameOrSerial.trim().toLowerCase();
    const bySerial = devices.find((d) => d.serialNumber.toLowerCase() === wanted);
    if (bySerial) return bySerial;
    const exact = devices.filter((d) => (d.accountName ?? '').toLowerCase() === wanted);
    if (exact.length === 1) return exact[0];
    const partial = devices.filter((d) => (d.accountName ?? '').toLowerCase().includes(wanted));
    if (partial.length === 1) return partial[0];
    const names = (partial.length > 1 ? partial : devices).map((d) => `${d.accountName} (${d.serialNumber})`).join(', ');
    if (partial.length > 1) {
      throw new McpToolError(`"${nameOrSerial}" matches more than one device: ${names}.`, {
        hint: 'Pass the exact device name or its serial number.',
      });
    }
    throw new McpToolError(`No Alexa device matches "${nameOrSerial}".`, { hint: `Known devices: ${names}.` });
  }

  getPlayerInfo(serial: string): Promise<unknown> {
    return this.call('getPlayerInfo', serial);
  }

  getAllDeviceVolumes(): Promise<{ volumes?: unknown[] }> {
    return this.call('getAllDeviceVolumes');
  }

  // --------------------------------------------------------------- reads

  listRoutines(): Promise<Record<string, unknown>[]> {
    return this.call('getAutomationRoutines', 2000);
  }

  listSmartHomeEntities(): Promise<Record<string, unknown>[]> {
    return this.call('getSmarthomeEntities');
  }

  listLists(): Promise<Record<string, unknown>[]> {
    return this.call('getListsV2');
  }

  getListItems(listId: string): Promise<Record<string, unknown>[]> {
    return this.call('getListItemsV2', listId, {});
  }

  listNotifications(): Promise<{ notifications?: Record<string, unknown>[] }> {
    return this.call('getNotifications', false);
  }

  // ------------------------------------------------------------ commands

  speak(serial: string, text: string, kind: 'speak' | 'announcement'): Promise<unknown> {
    return this.call('sendSequenceCommand', serial, kind, text);
  }

  announce(serials: string[], text: string): Promise<unknown> {
    return this.call('sendSequenceCommand', serials, 'announcement', text);
  }

  /**
   * A volume SEQUENCE, not the player's `VolumeLevelCommand` (`sendCommand`):
   * the player command is accepted with no error while nothing is playing and
   * changes nothing. Verified live 2026-10-07 — sendCommand left a soundbar at
   * 20; the sequence moved it to 21 and back.
   */
  setVolume(serial: string, level: number): Promise<unknown> {
    return this.call('sendSequenceCommand', serial, 'volume', level);
  }

  playback(serial: string, command: PlaybackCommand): Promise<unknown> {
    return this.call('sendCommand', serial, command, null);
  }

  runRoutine(serial: string, routine: Record<string, unknown>): Promise<unknown> {
    return this.call('executeAutomationRoutine', serial, routine);
  }

  async controlSmartHome(
    entityId: string,
    parameters: Record<string, unknown>,
    entityType: SmartHomeEntityType,
  ): Promise<unknown> {
    const body = await this.call<{ errors?: { code?: string; message?: string }[] }>(
      'executeSmarthomeDeviceAction',
      [entityId],
      parameters,
      entityType,
    );
    // phoenix/state answers 200 with per-entity errors (e.g. ENDPOINT_UNREACHABLE) — a 200 is not success.
    const errors = body?.errors ?? [];
    if (errors.length > 0) {
      const codes = errors.map((e) => e.code ?? e.message ?? 'UNKNOWN').join(', ');
      throw new McpToolError(`Alexa did not apply the smart-home action: ${codes}.`, {
        hint: 'ENDPOINT_UNREACHABLE means the device itself is offline or out of range of its hub.',
      });
    }
    return body;
  }

  addListItem(listId: string, value: string): Promise<unknown> {
    return this.call('addListItem', listId, { value });
  }

  removeListItem(listId: string, itemId: string, version: number): Promise<unknown> {
    return this.call('deleteListItem', listId, itemId, { version });
  }
}

/** The process-wide client. Built here, not in a registrar, so every served connection shares one session. */
export const client = new AlexaClient();
