import { vi } from 'vitest';
import type { RawDevice, RemoteFactory, RemoteInit, RemoteSession } from '../src/remote.js';
import type { Registration } from '../src/registration.js';

export const REGISTRATION: Registration = {
  refreshToken: 'Atnr|refresh-secret',
  deviceSerial: 'virtual-device-1',
  amazonPage: 'amazon.com',
  tokenDate: Date.now(),
  macDms: { device_private_key: 'k' },
};

export const DEVICES: RawDevice[] = [
  {
    accountName: 'Kitchen Echo',
    serialNumber: 'G0001',
    deviceType: 'A1',
    deviceFamily: 'ECHO',
    online: true,
    capabilities: ['VOLUME_SETTING', 'AUDIO_PLAYER', 'REMINDERS', 'TIMERS_AND_ALARMS', 'EQUALIZER_CONTROLLER_BASS', 'EQUALIZER_CONTROLLER_MIDRANGE', 'EQUALIZER_CONTROLLER_TREBLE'],
    softwareVersion: '1',
    // The library attaches device-preferences here during init (session.devices() only, not getDevices).
    preferences: { timeZoneId: 'America/New_York' },
  },
  { accountName: "Chris's Echo Show", serialNumber: 'G0002', deviceType: 'A2', deviceFamily: 'KNIGHT', online: true, capabilities: ['VOLUME_SETTING', 'REMINDERS'] },
  { accountName: 'Living Room TV', serialNumber: 'G0003', deviceType: 'A3', deviceFamily: 'FIRE_TV', online: false, capabilities: [] },
  { accountName: 'This Device', serialNumber: 'virtual-device-1', deviceType: 'A4', deviceFamily: 'UNKNOWN', online: true },
];

/** Library method name → handler returning the body (or throwing). */
export type Handlers = Record<string, (...args: unknown[]) => unknown>;

export interface FakeRemote {
  factory: RemoteFactory;
  calls: { method: string; args: unknown[] }[];
  inits: RemoteInit[];
  session: RemoteSession;
  handlers: Handlers;
  /** Make the next `factory()` reject with this error. */
  failNextInit(err: Error): void;
}

export function fakeRemote(handlers: Handlers = {}, devices: RawDevice[] = DEVICES): FakeRemote {
  const calls: FakeRemote['calls'] = [];
  const inits: RemoteInit[] = [];
  let nextInitError: Error | undefined;
  const session: RemoteSession = {
    devices: () => devices,
    call: async <T>(method: string, ...args: unknown[]) => {
      calls.push({ method, args });
      const handler = handlers[method];
      if (!handler) return {} as T;
      return (await handler(...args)) as T;
    },
    notificationObject: (serial, type, label, value, status) => {
      calls.push({ method: 'createNotificationObject', args: [serial, type, label, value, status] });
      const dev = devices.find((d) => d.serialNumber === serial);
      if (!dev) return null;
      // Mirrors alexa-remote2: alarms come back in the new (v1/alerts) style; reminders/timers in the old one.
      if (type === 'Alarm') return { trigger: { scheduledTime: 'library-local-time' }, extensions: [], endpointId: `${serial}@${dev.deviceType}` };
      return {
        type,
        deviceSerialNumber: serial,
        deviceType: dev.deviceType,
        reminderLabel: type !== 'Timer' ? label : null,
        timerLabel: type === 'Timer' ? label : null,
        alarmTime: value,
        originalDate: 'library-local-date',
        originalTime: 'library-local-time',
        id: null,
        status,
      };
    },
    stop: vi.fn(),
  };
  const factory: RemoteFactory = async (init) => {
    inits.push(init);
    if (nextInitError) {
      const err = nextInitError;
      nextInitError = undefined;
      throw err;
    }
    return session;
  };
  return {
    factory,
    calls,
    inits,
    session,
    handlers,
    failNextInit: (err) => {
      nextInitError = err;
    },
  };
}
