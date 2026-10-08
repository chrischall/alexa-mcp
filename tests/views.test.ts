import { describe, expect, it } from 'vitest';
import {
  compactDevice,
  compactListItem,
  compactNotification,
  compactRoutine,
  compactSmartHomeEntity,
  compactSmartHomeState,
  compactVolume,
  parseCapabilityStates,
} from '../src/views.js';
import { DEVICES } from './fakes.js';

describe('compact views (shapes captured from the live API, values invented)', () => {
  it('device keeps name/serial/family/online and the capabilities a caller acts on', () => {
    expect(compactDevice(DEVICES[0])).toEqual({
      name: 'Kitchen Echo',
      serial: 'G0001',
      family: 'ECHO',
      online: true,
      canSetVolume: true,
    });
  });

  it('routine exposes id, name, enabled and how it is triggered', () => {
    const routine = {
      automationId: 'amzn1.alexa.automation.1',
      name: null,
      status: 'ENABLED',
      triggers: [{ type: 'CustomUtterance', payload: { utterance: 'good night' } }],
      sequence: { startNode: {} },
    };
    expect(compactRoutine(routine)).toEqual({
      id: 'amzn1.alexa.automation.1',
      name: 'good night',
      enabled: true,
      triggers: ['CustomUtterance: good night'],
    });
  });

  it('routine with a schedule trigger and no name falls back to the id', () => {
    const routine = {
      automationId: 'r2',
      status: 'DISABLED',
      triggers: [{ type: 'Schedule', payload: { recurrencePattern: 'P1D' } }],
    };
    expect(compactRoutine(routine)).toMatchObject({ name: 'r2', enabled: false, triggers: ['Schedule'] });
  });

  it('smart-home entity keeps only the operations this server can perform', () => {
    const entity = {
      id: 'e1',
      displayName: 'Porch Light',
      description: 'Hue light',
      availability: 'AVAILABLE',
      supportedOperations: ['turnOn', 'turnOff', 'setBrightness', 'rampBrightness', 'setModeValue@abc_Light.Effect'],
      providerData: { categoryType: 'APPLIANCE', deviceType: 'LIGHT' },
    };
    expect(compactSmartHomeEntity(entity)).toEqual({
      id: 'e1',
      name: 'Porch Light',
      kind: 'LIGHT',
      entityType: 'APPLIANCE',
      available: true,
      actions: ['turnOn', 'turnOff', 'setBrightness'],
    });
  });

  it('scene and group entities map to the entityType the control call needs', () => {
    expect(compactSmartHomeEntity({ id: 's', displayName: 'Movie', supportedOperations: ['sceneActivate'], providerData: { categoryType: 'SCENE', deviceType: 'SCENE_TRIGGER' } })).toMatchObject({ entityType: 'APPLIANCE', actions: ['sceneActivate'] });
    expect(compactSmartHomeEntity({ id: 'g', displayName: 'Downstairs', supportedOperations: ['turnOn'], providerData: { categoryType: 'GROUP' } })).toMatchObject({ entityType: 'GROUP' });
  });

  it('list item reports completion and keeps the version removal needs', () => {
    expect(compactListItem({ itemId: 'i1', itemName: 'milk', itemStatus: 'ACTIVE', version: 2, quantity: null, note: null })).toEqual({
      id: 'i1',
      name: 'milk',
      completed: false,
      version: 2,
    });
  });

  it('notification normalises alarms, timers and reminders', () => {
    expect(
      compactNotification({ type: 'Reminder', status: 'ON', reminderLabel: 'call mom', deviceSerialNumber: 'G0001', originalDate: '2026-10-08', originalTime: '09:00:00.000', recurringPattern: null }),
    ).toEqual({ id: null, type: 'Reminder', on: true, label: 'call mom', device: 'G0001', date: '2026-10-08', time: '09:00', recurring: null });
  });

  it('volume reports level and mute per device serial', () => {
    expect(compactVolume({ dsn: 'G0001', speakerVolume: 40, speakerMuted: false, alertVolume: null })).toEqual({ serial: 'G0001', volume: 40, muted: false });
  });

  it('capability states: JSON strings are parsed, garbage is dropped', () => {
    expect(parseCapabilityStates(['{"namespace":"Alexa.PowerController","name":"powerState","value":"OFF"}', 'not json', 7, { namespace: 'A', name: 'b', value: 1 }])).toEqual([
      { namespace: 'Alexa.PowerController', name: 'powerState', value: 'OFF' },
      { namespace: 'A', name: 'b', value: 1 },
    ]);
    expect(parseCapabilityStates(undefined)).toEqual([]);
  });

  it('state projection covers colour, colour temperature, single setpoint, lock, contact and motion', () => {
    const s = (namespace: string, name: string, value: unknown) => ({ namespace, name, value });
    expect(
      compactSmartHomeState([
        s('Alexa.ColorController', 'color', { hue: 0, saturation: 1, brightness: 1 }),
        s('Alexa.ColorTemperatureController', 'colorTemperatureInKelvin', 2700),
        s('Alexa.ThermostatController', 'targetSetpoint', { value: 21, scale: 'CELSIUS' }),
        s('Alexa.LockController', 'lockState', 'LOCKED'),
        s('Alexa.ContactSensor', 'detectionState', 'NOT_DETECTED'),
        s('Alexa.MotionSensor', 'detectionState', 'DETECTED'),
        s('Alexa.EndpointHealth', 'connectivity', { value: 'UNREACHABLE' }),
      ]),
    ).toEqual({
      color: { hue: 0, saturation: 1, brightness: 1 },
      colorTemperatureInKelvin: 2700,
      targetSetpoint: 21,
      scale: 'CELSIUS',
      lockState: 'LOCKED',
      contact: 'NOT_DETECTED',
      motion: 'DETECTED',
      connectivity: 'UNREACHABLE',
    });
  });
});
