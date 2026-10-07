import { CONFIRM_FLOW_SENTENCE, McpToolError } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { AlexaClient } from '../client.js';
import type { RawDevice } from '../remote.js';

export const deviceArg = z
  .string()
  .min(1)
  .describe('An Alexa device: its name as alexa_list_devices shows it (case-insensitive; a unique part of the name works) or its serial number.');

/** Appended to every confirm-gated tool's description. */
export const WRITE_SUFFIX = ` ${CONFIRM_FLOW_SENTENCE}`;

/** The device a command runs "on" when the caller doesn't name one: the first online device that can play audio. */
export async function defaultDevice(client: AlexaClient): Promise<RawDevice> {
  const devices = await client.listDevices();
  const pick = devices.find((d) => d.online && (d.capabilities ?? []).includes('VOLUME_SETTING'));
  if (!pick) {
    throw new McpToolError('No online Alexa speaker was found to run this on.', {
      hint: 'Pass `device` explicitly — alexa_list_devices shows which are online.',
    });
  }
  return pick;
}
