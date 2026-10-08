/**
 * Compact projections — the default `view` of every read tool.
 *
 * The raw records are large (a device carries 9–80 capability strings, a
 * routine its whole action graph), and an agent browsing or picking a target
 * needs a few fields. Every field read here was captured from the live API on
 * 2026-10-07 (key structure only); the `full` view returns the raw record.
 */

import type { RawDevice } from './remote.js';

type Rec = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export function compactDevice(d: RawDevice) {
  return {
    name: d.accountName ?? d.serialNumber,
    serial: d.serialNumber,
    family: d.deviceFamily ?? null,
    online: d.online === true,
    canSetVolume: (d.capabilities ?? []).includes('VOLUME_SETTING'),
  };
}

function describeTrigger(t: Rec): string {
  const payload = (t.payload ?? {}) as Rec;
  const utterance = str(payload.utterance);
  return utterance ? `${String(t.type)}: ${utterance}` : String(t.type);
}

export function compactRoutine(r: Rec) {
  const triggers = Array.isArray(r.triggers) ? (r.triggers as Rec[]) : [];
  const utterance = triggers.map((t) => str(((t.payload ?? {}) as Rec).utterance)).find(Boolean);
  return {
    id: String(r.automationId),
    // Voice-triggered routines usually have no name; the phrase IS the name people use.
    name: str(r.name) ?? utterance ?? String(r.automationId),
    enabled: r.status === 'ENABLED',
    triggers: triggers.map(describeTrigger),
  };
}

/** The `phoenix/state` actions alexa_control_smart_home sends. */
export const SMART_HOME_ACTIONS = ['turnOn', 'turnOff', 'setBrightness', 'sceneActivate', 'setColor', 'setColorTemperature'] as const;
export type SmartHomeAction = (typeof SMART_HOME_ACTIONS)[number];

/**
 * supportedOperations → the action name this server offers for it, in display
 * order. Anything not here (unlockAction, rampBrightness, vendor modes) is not
 * offered. Unlocking stays out deliberately: it reduces security.
 */
const OFFERED_ACTIONS: [operation: string, action: string][] = [
  ['turnOn', 'turnOn'],
  ['turnOff', 'turnOff'],
  ['setBrightness', 'setBrightness'],
  ['sceneActivate', 'sceneActivate'],
  ['setColor', 'setColor'],
  ['setColorTemperature', 'setColorTemperature'],
  // Performed by alexa_set_thermostat.
  ['setTargetTemperature', 'setTemperature'],
  ['setThermostatMode', 'setThermostatMode'],
  // Performed by alexa_lock.
  ['lockAction', 'lock'],
  ['unlockAction', 'unlock'],
];

/** The mode instance a garage door's open/close goes through. */
export const GARAGE_INSTANCE = 'GarageDoor.Position';

/**
 * `setModeValue@<uuid>_<instance>` → `<instance>`: everything after the first
 * `_` following the uuid (`5`, `Robot.MobilityState`, `Light.Effect`).
 */
export function modeInstance(operation: string): string | undefined {
  if (!operation.startsWith('setModeValue@')) return undefined;
  const rest = operation.slice('setModeValue@'.length);
  const cut = rest.indexOf('_');
  return cut >= 0 && cut < rest.length - 1 ? rest.slice(cut + 1) : undefined;
}

/** Every mode-controller instance an entity's supportedOperations declare, in order, de-duplicated. */
export function modeInstances(e: Rec): string[] {
  const ops = Array.isArray(e.supportedOperations) ? (e.supportedOperations as string[]) : [];
  return [...new Set(ops.map(modeInstance).filter((i): i is string => i !== undefined))];
}

/** A garage door: its category says so, or it has a GarageDoor.Position mode. */
export function isGarageDoor(e: Rec): boolean {
  const provider = (e.providerData ?? {}) as Rec;
  return provider.deviceType === 'GARAGE_DOOR' || modeInstances(e).includes(GARAGE_INSTANCE);
}

export function compactSmartHomeEntity(e: Rec) {
  const provider = (e.providerData ?? {}) as Rec;
  const ops = Array.isArray(e.supportedOperations) ? (e.supportedOperations as string[]) : [];
  return {
    id: String(e.id),
    name: str(e.displayName) ?? String(e.id),
    kind: str(provider.deviceType) ?? str(provider.categoryType) ?? null,
    entityType: provider.categoryType === 'GROUP' || provider.categoryType === 'VIRTUALGROUP' ? 'GROUP' : 'APPLIANCE',
    available: (e.availability ?? 'AVAILABLE') === 'AVAILABLE',
    actions: [
      ...OFFERED_ACTIONS.filter(([op]) => ops.includes(op)).map(([, action]) => action),
      // Garage doors: alexa_garage_door. Other mode controllers (fan mode, vacuum, light effect): alexa_set_device_mode.
      ...(isGarageDoor(e) ? ['open', 'close'] : modeInstances(e).length > 0 ? ['setMode'] : []),
    ],
  };
}

/** One parsed `capabilityStates` element: `{ namespace, name, instance?, value }`. */
export interface CapabilityState {
  namespace: string;
  name: string;
  instance?: string;
  value: unknown;
  [key: string]: unknown;
}

/** `querySmarthomeDevices` capabilityStates — each element may arrive as a JSON string (live 2026-10-08). */
export function parseCapabilityStates(raw: unknown): CapabilityState[] {
  if (!Array.isArray(raw)) return [];
  const out: CapabilityState[] = [];
  for (const el of raw) {
    let v: unknown = el;
    if (typeof el === 'string') {
      try {
        v = JSON.parse(el);
      } catch {
        continue;
      }
    }
    if (v && typeof v === 'object' && typeof (v as Rec).namespace === 'string' && typeof (v as Rec).name === 'string') {
      out.push(v as CapabilityState);
    }
  }
  return out;
}

/** A temperature value: `{ value, scale }` or a bare number. */
export function temperatureValue(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && typeof (v as Rec).value === 'number') return (v as Rec).value as number;
  return undefined;
}
const scaleOf = (v: unknown): string | undefined => (v && typeof v === 'object' ? str((v as Rec).scale) : undefined);

/**
 * The common, documented capability states, flattened. Temperatures are bare
 * numbers with one shared `scale`. Only fields the device reports appear.
 */
export function compactSmartHomeState(states: CapabilityState[]): Rec {
  const get = (namespace: string, name: string) => states.find((s) => s.namespace === namespace && s.name === name)?.value;
  const out: Rec = {};
  const put = (key: string, v: unknown) => {
    if (v !== undefined && v !== null) out[key] = v;
  };
  put('power', get('Alexa.PowerController', 'powerState'));
  put('brightness', get('Alexa.BrightnessController', 'brightness'));
  put('color', get('Alexa.ColorController', 'color'));
  put('colorTemperatureInKelvin', get('Alexa.ColorTemperatureController', 'colorTemperatureInKelvin'));
  const temperature = get('Alexa.TemperatureSensor', 'temperature');
  const lower = get('Alexa.ThermostatController', 'lowerSetpoint');
  const upper = get('Alexa.ThermostatController', 'upperSetpoint');
  const target = get('Alexa.ThermostatController', 'targetSetpoint');
  put('temperature', temperatureValue(temperature));
  const scale =
    str(get('Alexa.ThermostatController.Configuration', 'temperatureScale')) ??
    [temperature, lower, upper, target].map(scaleOf).find(Boolean);
  if (temperature !== undefined || lower !== undefined || upper !== undefined || target !== undefined) put('scale', scale);
  put('humidity', get('Alexa.HumiditySensor', 'relativeHumidity'));
  put('thermostatMode', get('Alexa.ThermostatController', 'thermostatMode'));
  put('lowerSetpoint', temperatureValue(lower));
  put('upperSetpoint', temperatureValue(upper));
  put('targetSetpoint', temperatureValue(target));
  const hvacNs = 'Alexa.ThermostatController.HVAC.Components';
  const hvac: Rec = {};
  for (const [key, name] of [
    ['cooler', 'coolerOperation'],
    ['heater', 'primaryHeaterOperation'],
    ['fan', 'fanOperation'],
  ] as const) {
    const v = get(hvacNs, name);
    if (v !== undefined) hvac[key] = v;
  }
  if (Object.keys(hvac).length > 0) out.hvac = hvac;
  put('lockState', get('Alexa.LockController', 'lockState'));
  put('contact', get('Alexa.ContactSensor', 'detectionState'));
  put('motion', get('Alexa.MotionSensor', 'detectionState'));
  const conn = get('Alexa.EndpointHealth', 'connectivity');
  put('connectivity', conn && typeof conn === 'object' ? (conn as Rec).value : conn);
  return out;
}

/** `getBluetooth` → per-Echo paired devices. Paired-device names are third-party text. */
export function compactBluetooth(b: Rec) {
  const paired = Array.isArray(b.pairedDeviceList) ? (b.pairedDeviceList as Rec[]) : [];
  return {
    serial: String(b.deviceSerialNumber),
    online: b.online === true,
    streamingState: str(b.streamingState) ?? null,
    paired: paired.map((p) => ({
      name: str(p.friendlyName) ?? null,
      address: str(p.address) ?? null,
      ...(typeof p.connected === 'boolean' ? { connected: p.connected } : {}),
    })),
  };
}

export function compactList(l: Rec) {
  const agg = (l.aggregatedAttributes ?? {}) as Rec;
  return {
    id: String(l.listId),
    type: str(l.listType) ?? null,
    name: str(l.listName) ?? str(l.name) ?? (l.listType === 'SHOP' ? 'Shopping' : l.listType === 'TODO' ? 'To-do' : null),
    activeItems: agg.totalActiveItemsCount === undefined ? null : Number(agg.totalActiveItemsCount),
  };
}

export function compactListItem(i: Rec) {
  return {
    id: String(i.itemId),
    name: str(i.itemName) ?? '',
    completed: i.itemStatus === 'COMPLETE',
    version: i.version as number,
    ...(i.quantity != null ? { quantity: i.quantity } : {}),
    ...(str(i.note) ? { note: i.note } : {}),
  };
}

export function compactNotification(n: Rec) {
  const time = str(n.originalTime);
  return {
    id: str(n.id) ?? null,
    type: str(n.type) ?? null,
    on: n.status === 'ON',
    label: str(n.reminderLabel) ?? str(n.timerLabel) ?? null,
    device: str(n.deviceSerialNumber) ?? null,
    date: str(n.originalDate) ?? null,
    time: time ? time.slice(0, 5) : null,
    recurring: str(n.recurringPattern) ?? null,
  };
}

export function compactVolume(v: Rec) {
  return { serial: String(v.dsn), volume: v.speakerVolume as number, muted: v.speakerMuted === true };
}
