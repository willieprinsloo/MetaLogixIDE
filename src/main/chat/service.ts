/**
 * Chat service — the one-entry-at-a-time serialisation point.
 * All posts (local IPC, remote P2P, companion CLI) flow through
 * `append` so each entry gets a unique `id`, a canonical `ts`, and
 * a single `chat:changed` broadcast.
 */
import type { ChatEntry, ChatMention } from '@shared/chat';
import { appendChat, nextChatId, readRecentChat } from './log';

/** Minimal projects dep — any repo with `get(id)` that returns a `{ path }`. */
export interface ChatProjectsDep {
  get(id: number): { id: number; path: string } | null | undefined;
}

export interface ChatServiceDeps {
  projects: ChatProjectsDep;
  /** This metaIDE instance's deviceId (stamped onto every entry's `from.device`). */
  deviceId: string;
  /** Fires `chat:changed` to every open renderer. */
  broadcast: (channel: 'chat:changed', payload: { projectId: number; entry: ChatEntry }) => void;
}

export interface AppendReq {
  projectId: number;
  from: Omit<ChatEntry['from'], 'device'>;
  to?: ChatMention[];
  body: string;
  reply_in?: string;
  meta?: ChatEntry['meta'];
}

export interface ListReq {
  projectId: number;
  limit?: number;
}

export interface ChatService {
  append(req: AppendReq): Promise<{ entry: ChatEntry }>;
  list(req: ListReq): Promise<{ entries: ChatEntry[] }>;
  listSince(projectId: number, sinceTs: string): Promise<{ entries: ChatEntry[] }>;
}

export function createChatService(deps: ChatServiceDeps): ChatService {
  return {
    async append(req) {
      const project = deps.projects.get(req.projectId);
      if (!project) throw new Error(`unknown project ${req.projectId}`);
      const entry: ChatEntry = {
        id: nextChatId(deps.deviceId),
        ts: new Date().toISOString(),
        from: { ...req.from, device: deps.deviceId },
        to: req.to ?? [],
        body: req.body,
        ...(req.reply_in !== undefined ? { reply_in: req.reply_in } : {}),
        ...(req.meta !== undefined ? { meta: req.meta } : {}),
      };
      appendChat(project.path, entry);
      deps.broadcast('chat:changed', { projectId: req.projectId, entry });
      return { entry };
    },

    async list(req) {
      const project = deps.projects.get(req.projectId);
      if (!project) throw new Error(`unknown project ${req.projectId}`);
      const cap = Math.max(1, Math.min(500, req.limit ?? 100));
      const entries = readRecentChat(project.path, cap);
      return { entries };
    },

    async listSince(projectId, sinceTs) {
      const project = deps.projects.get(projectId);
      if (!project) throw new Error(`unknown project ${projectId}`);
      // Read a generous tail and filter. 500 entries is already the
      // page cap — if more than 500 arrived in the sync gap, the next
      // reconnect picks up the rest.
      const entries = readRecentChat(project.path, 500).filter((e) => e.ts > sinceTs);
      return { entries };
    },
  };
}
