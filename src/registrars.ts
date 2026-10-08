/**
 * The server's tool surface, in one list — kept out of `index.ts` (which boots
 * a stdio server on import) so tests can assert the real roster.
 */

import type { ToolRegistrar } from '@chrischall/mcp-utils';
import type { AlexaClient } from './client.js';
import { registerActionTools } from './tools/actions.js';
import { registerDeviceTools } from './tools/devices.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';
import { registerListTools } from './tools/lists.js';
import { registerLoginTools } from './tools/login.js';
import { registerNotificationTools } from './tools/notifications.js';
import { registerRoutineTools } from './tools/routines.js';
import { registerSessionTools } from './tools/session.js';
import { registerSettingsTools } from './tools/settings.js';
import { registerSmartHomeTools } from './tools/smarthome.js';
import { registerSpeechTools } from './tools/speech.js';
import { registerVacationTools } from './tools/vacation.js';

export const TOOL_REGISTRARS: ToolRegistrar<AlexaClient>[] = [
  registerHealthcheckTools,
  registerSessionTools,
  registerLoginTools,
  registerDeviceTools,
  registerSpeechTools,
  registerActionTools,
  registerSettingsTools,
  registerRoutineTools,
  registerSmartHomeTools,
  registerVacationTools,
  registerListTools,
  registerNotificationTools,
];
