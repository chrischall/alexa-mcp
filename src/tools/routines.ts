import type { McpServer } from '@modelcontextprotocol/server';
import {
  McpToolError,
  confirmTokenParam,
  confirmWrite,
  minifiedResult,
  resolveView,
  toolAnnotations,
  viewParam,
  viewResult,
} from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { AlexaClient } from '../client.js';
import { compactRoutine } from '../views.js';
import { WRITE_SUFFIX, defaultDevice } from './common.js';

const VIEWS = ['compact', 'full'] as const;

/** Find a routine by id, name or trigger phrase (case-insensitive, exact before unique substring). */
export function findRoutine(routines: Record<string, unknown>[], query: string): Record<string, unknown> {
  const q = query.trim().toLowerCase();
  const named = routines.map((r) => ({ r, c: compactRoutine(r) }));
  const byId = named.find(({ c }) => c.id.toLowerCase() === q);
  if (byId) return byId.r;
  const exact = named.filter(({ c }) => c.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0].r;
  const partial = named.filter(({ c }) => c.name.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0].r;
  const list = (partial.length > 1 ? partial : named).map(({ c }) => c.name).join(', ');
  throw new McpToolError(
    partial.length > 1 ? `"${query}" matches more than one routine: ${list}.` : `No routine matches "${query}".`,
    { hint: partial.length > 1 ? 'Use the exact name or the routine id.' : `Routines: ${list}.` },
  );
}

export function registerRoutineTools(server: McpServer, client: AlexaClient): void {
  server.registerTool(
    'alexa_list_routines',
    {
      description:
        'List the Alexa routines on the account — name (or trigger phrase), id, whether enabled, and what triggers ' +
        'each (voice phrase, schedule, device event).',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({ view: viewParam(VIEWS) }),
    },
    async ({ view }) => {
      const routines = await client.listRoutines();
      const v = resolveView(view, VIEWS);
      return viewResult(v, v === 'full' ? routines : routines.map(compactRoutine));
    },
  );

  server.registerTool(
    'alexa_run_routine',
    {
      description:
        'Run an Alexa routine now, exactly as if its trigger fired. A routine can do anything it was built to — ' +
        'lights, locks, messages, purchases — so check what it does before running it.' +
        WRITE_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: true }),
      inputSchema: z.object({
        routine: z.string().min(1).describe('Routine name, trigger phrase or id (from alexa_list_routines).'),
        device: z
          .string()
          .min(1)
          .optional()
          .describe('Device the routine runs on (where spoken responses play). Defaults to the first online speaker.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ routine, device, confirmToken }, ctx) => {
      const target = findRoutine(await client.listRoutines(), routine);
      const dev = device ? await client.resolveDevice(device) : await defaultDevice(client);
      const compact = compactRoutine(target);
      const gate = await confirmWrite(ctx, {
        tool: 'alexa_run_routine',
        action: 'alexa.run_routine',
        summary: `Run routine "${compact.name}" on ${dev.accountName}`,
        account: undefined,
        target: compact.id,
        payload: { routine: compact.id, device: dev.serialNumber },
        confirmToken,
      });
      if (gate) return gate;
      await client.runRoutine(dev.serialNumber, target);
      return minifiedResult({ ok: true, routine: compact.name, device: dev.accountName });
    },
  );
}
