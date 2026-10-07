#!/usr/bin/env node
/**
 * Entry point. `alexa-mcp login …` runs the one-time sign-in; anything else
 * serves MCP over stdio. The client is built in `client.ts`, not in a
 * registrar, so the server boots with no registration (the error surfaces on
 * the first tool call) and every served connection shares one Alexa session.
 */

import { runMcp } from '@chrischall/mcp-utils';
import { client } from './client.js';
import { TOOL_REGISTRARS } from './registrars.js';
import { VERSION } from './version.js';

if (process.argv[2] === 'login') {
  const { runLogin } = await import('./login.js');
  try {
    await runLogin(process.argv.slice(3));
    process.exit(0);
  } catch (err) {
    console.error(`[alexa-mcp] Sign-in failed: ${(err as Error).message ?? err}`);
    process.exit(1);
  }
} else {
  await runMcp({
    name: 'alexa-mcp',
    version: VERSION,
    banner: '[alexa-mcp] This project was developed and is maintained by AI. Use at your own discretion.',
    deps: client,
    tools: TOOL_REGISTRARS,
  });
}
