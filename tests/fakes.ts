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
  { accountName: 'Kitchen Echo', serialNumber: 'G0001', deviceType: 'A1', deviceFamily: 'ECHO', online: true, capabilities: ['VOLUME_SETTING', 'AUDIO_PLAYER'], softwareVersion: '1' },
  { accountName: "Chris's Echo Show", serialNumber: 'G0002', deviceType: 'A2', deviceFamily: 'KNIGHT', online: true, capabilities: ['VOLUME_SETTING'] },
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
