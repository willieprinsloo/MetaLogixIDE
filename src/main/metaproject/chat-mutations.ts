/** Maps one current Chat mutation to an existing protected reference REST route. */
import { z } from 'zod';
import { WebFailure, type WebMutation } from './web-session';

type Target = { readonly projectId: number; readonly channelId: number };
type Change =
  | { readonly kind: 'send'; readonly message: string; readonly parentMessageId?: number | null }
  | { readonly kind: 'edit'; readonly messageId: number; readonly message: string }
  | { readonly kind: 'delete'; readonly messageId: number }
  | { readonly kind: 'mark-read'; readonly lastMessageId: number };

export type ChatMutation = Target & Change;
export type ChatRead = <T>(path: string, schema: z.ZodType<T>, request: WebMutation) => Promise<T>;
const id = z.number().int().positive();
const accepted = z.object({ success: z.literal(true) });
const saved = accepted.extend({ message: z.object({ id, channel_id: id, project_id: id.nullable() }) });
const deleted = saved.extend({ id });
const ok = { ok: true } as const;

/** Acknowledge only after the scoped service response confirms acceptance; never replay. */
export async function mutateChat(read: ChatRead, input: ChatMutation): Promise<{ ok: true }> {
  const path = `/api/projects/${input.projectId}/chat/channels/${input.channelId}`;
  if (input.kind === 'mark-read') {
    await read(`${path}/read/`, accepted, { method: 'POST', json: { last_message_id: input.lastMessageId } });
    return ok;
  }
  const response = await changeMessage(read, path, input);
  if (response.channel_id !== input.channelId) throw new WebFailure('protocol');
  if (input.kind === 'send' ? response.project_id !== input.projectId : response.id !== input.messageId) throw new WebFailure('protocol');
  return ok;
}

async function changeMessage(read: ChatRead, path: string, input: Exclude<Change, { kind: 'mark-read' }>): Promise<z.output<typeof saved>['message']> {
  if (input.kind === 'send') {
    return (await read(`${path}/messages/`, saved, { method: 'POST', json: { message: input.message, parent_message_id: input.parentMessageId ?? null } })).message;
  }
  const item = `${path}/messages/${input.messageId}/`;
  if (input.kind === 'edit') return (await read(item, saved, { method: 'PATCH', json: { message: input.message } })).message;
  const reply = await read(item, deleted, { method: 'DELETE' });
  if (reply.id !== input.messageId) throw new WebFailure('protocol');
  return reply.message;
}
