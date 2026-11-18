import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendChat, readRecentChat, chatPath, nextChatId } from '@main/chat/log';
import { CHAT_BODY_MAX, type ChatEntry } from '@shared/chat';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chat-log-'));
});

describe('chat log', () => {
  it('appends then reads one entry', () => {
    const entry: ChatEntry = {
      id: 'a',
      ts: '2026-11-18T10:00:00Z',
      from: { device: 'd1', shell: 1, agent: 'claude' },
      to: [],
      body: 'hi',
    };
    appendChat(dir, entry);
    expect(readRecentChat(dir, 10)).toEqual([entry]);
  });

  it('truncates bodies over CHAT_BODY_MAX with an ellipsis', () => {
    const big = 'x'.repeat(CHAT_BODY_MAX + 500);
    appendChat(dir, {
      id: 'b',
      ts: '2026-11-18T10:00:01Z',
      from: { device: 'd1', shell: 1, agent: 'claude' },
      to: [],
      body: big,
    });
    const [got] = readRecentChat(dir, 10);
    expect(got.body.length).toBe(CHAT_BODY_MAX + 1); // +1 for the ellipsis
    expect(got.body.endsWith('…')).toBe(true);
  });

  it('readRecentChat returns at most `limit` entries, newest wins', () => {
    for (let i = 0; i < 20; i++) {
      appendChat(dir, {
        id: `e${i}`,
        ts: '2026-11-18T10:00:00Z',
        from: { device: 'd1', shell: 1, agent: 'claude' },
        to: [],
        body: String(i),
      });
    }
    const out = readRecentChat(dir, 5);
    expect(out.map((e) => e.body)).toEqual(['15', '16', '17', '18', '19']);
  });

  it('nextChatId embeds the device id', () => {
    expect(nextChatId('mac-mini')).toMatch(/^[a-z0-9]+-mac-mini-[a-z0-9]+$/);
  });

  it('chatPath points to <project>/.metaide/chat.jsonl', () => {
    expect(chatPath('/p')).toBe(join('/p', '.metaide', 'chat.jsonl'));
  });
});
