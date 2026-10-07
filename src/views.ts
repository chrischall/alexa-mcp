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

/** The `phoenix/state` actions this server sends. Anything else in supportedOperations is not offered. */
export const SMART_HOME_ACTIONS = ['turnOn', 'turnOff', 'setBrightness', 'sceneActivate'] as const;
export type SmartHomeAction = (typeof SMART_HOME_ACTIONS)[number];

export function compactSmartHomeEntity(e: Rec) {
  const provider = (e.providerData ?? {}) as Rec;
  const ops = Array.isArray(e.supportedOperations) ? (e.supportedOperations as string[]) : [];
  return {
    id: String(e.id),
    name: str(e.displayName) ?? String(e.id),
    kind: str(provider.deviceType) ?? str(provider.categoryType) ?? null,
    entityType: provider.categoryType === 'GROUP' || provider.categoryType === 'VIRTUALGROUP' ? 'GROUP' : 'APPLIANCE',
    available: (e.availability ?? 'AVAILABLE') === 'AVAILABLE',
    actions: SMART_HOME_ACTIONS.filter((a) => ops.includes(a)),
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
