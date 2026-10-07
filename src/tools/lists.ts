import type { McpServer } from '@modelcontextprotocol/server';
import {
  McpToolError,
  UNTRUSTED_DESCRIPTION_SUFFIX,
  confirmTokenParam,
  confirmWrite,
  minifiedResult,
  toolAnnotations,
  untrustedResult,
} from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { AlexaClient } from '../client.js';
import { compactList, compactListItem } from '../views.js';
import { WRITE_SUFFIX } from './common.js';

const listArg = z
  .string()
  .min(1)
  .describe('Which list: "shopping", "todo", a list name, or a list id from alexa_list_lists.');

export async function resolveList(client: AlexaClient, query: string) {
  const lists = (await client.listLists()).map(compactList);
  const q = query.trim().toLowerCase();
  const alias = q === 'shopping' || q === 'shop' ? 'SHOP' : q === 'todo' || q === 'to-do' || q === 'to do' ? 'TODO' : null;
  const match =
    lists.find((l) => l.id.toLowerCase() === q) ??
    (alias ? lists.find((l) => l.type === alias) : undefined) ??
    lists.find((l) => (l.name ?? '').toLowerCase() === q);
  if (!match) {
    throw new McpToolError(`No Alexa list matches "${query}".`, {
      hint: `Lists: ${lists.map((l) => `${l.name ?? l.type} (${l.id})`).join(', ')}.`,
    });
  }
  return match;
}

export function registerListTools(server: McpServer, client: AlexaClient): void {
  server.registerTool(
    'alexa_list_lists',
    {
      description: 'List the Alexa shopping and to-do lists on the account, with how many active items each has.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({}),
    },
    async () => minifiedResult((await client.listLists()).map(compactList)),
  );

  server.registerTool(
    'alexa_get_list_items',
    {
      description:
        'Read the items on an Alexa shopping or to-do list. Completed items are omitted unless includeCompleted is set. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({
        list: listArg,
        includeCompleted: z.boolean().default(false).describe('Also return checked-off items.'),
      }),
    },
    async ({ list, includeCompleted }) => {
      const target = await resolveList(client, list);
      const items = (await client.getListItems(target.id)).map(compactListItem);
      return untrustedResult({ list: target.name ?? target.type, items: includeCompleted ? items : items.filter((i) => !i.completed) });
    },
  );

  server.registerTool(
    'alexa_add_list_item',
    {
      description: 'Add an item to an Alexa shopping or to-do list.' + WRITE_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: false }),
      inputSchema: z.object({
        list: listArg,
        item: z.string().min(1).max(256).describe('The item text, e.g. "oat milk".'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ list, item, confirmToken }, ctx) => {
      const target = await resolveList(client, list);
      const gate = await confirmWrite(ctx, {
        tool: 'alexa_add_list_item',
        action: 'alexa.add_list_item',
        summary: `Add "${item}" to ${target.name ?? target.type}`,
        account: undefined,
        target: target.id,
        payload: { listId: target.id, item },
        confirmToken,
      });
      if (gate) return gate;
      await client.addListItem(target.id, item);
      return minifiedResult({ ok: true, list: target.name ?? target.type, item });
    },
  );

  server.registerTool(
    'alexa_remove_list_item',
    {
      description:
        'Delete an item from an Alexa shopping or to-do list (by its name or item id from alexa_get_list_items). ' +
        'This deletes it outright — any quantity or note on it is lost.' +
        WRITE_SUFFIX,
      annotations: toolAnnotations({ readOnly: false, destructive: true }),
      inputSchema: z.object({
        list: listArg,
        item: z.string().min(1).describe('Item text (exact, case-insensitive) or item id.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ list, item, confirmToken }, ctx) => {
      const target = await resolveList(client, list);
      const items = (await client.getListItems(target.id)).map(compactListItem);
      const q = item.trim().toLowerCase();
      const byId = items.find((i) => i.id.toLowerCase() === q);
      const byName = items.filter((i) => i.name.toLowerCase() === q);
      const found = byId ?? (byName.length === 1 ? byName[0] : undefined);
      if (!found) {
        throw new McpToolError(
          byName.length > 1 ? `"${item}" appears ${byName.length} times on the list.` : `"${item}" is not on ${target.name ?? target.type}.`,
          { hint: byName.length > 1 ? 'Pass the item id from alexa_get_list_items.' : 'alexa_get_list_items shows what is there.' },
        );
      }
      const gate = await confirmWrite(ctx, {
        tool: 'alexa_remove_list_item',
        action: 'alexa.remove_list_item',
        summary: `Remove "${found.name}" from ${target.name ?? target.type}`,
        account: undefined,
        target: found.id,
        revision: String(found.version),
        payload: { listId: target.id, itemId: found.id, version: found.version },
        confirmToken,
      });
      if (gate) return gate;
      await client.removeListItem(target.id, found.id, found.version);
      return minifiedResult({ ok: true, list: target.name ?? target.type, removed: found.name });
    },
  );
}
