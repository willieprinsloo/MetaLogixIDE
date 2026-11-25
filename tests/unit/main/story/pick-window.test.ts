/**
 * Picker tests. We seed activity/chat at known timestamps, then walk the
 * ladder with a fixed clock and verify:
 *  - short windows win when the project is busy right now
 *  - the picker expands when the latest window is thin
 *  - 7-day cap is reached cleanly for long-dormant projects
 *  - threshold honours EITHER events OR chat (per operator choice:
 *    ≥50 events OR ≥5 chat exchanges)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ActivityEntry } from '@shared/activity';
import type { ChatEntry } from '@shared/chat';
import {
  MIN_CHAT_FOR_STORY,
  MIN_EVENTS_FOR_STORY,
  WINDOW_LADDER_MINUTES,
  pickStoryWindowMinutes,
} from '@main/story/pick-window';

function seedActivity(projectPath: string, entries: ActivityEntry[]): void {
  const dir = join(projectPath, '.metaide');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'activity.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''),
    'utf8',
  );
}

function seedChat(projectPath: string, entries: ChatEntry[]): void {
  const dir = join(projectPath, '.metaide');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'chat.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''),
    'utf8',
  );
}

function manyEvents(count: number, minutesAgo: number, baseIso: string): ActivityEntry[] {
  const base = new Date(baseIso).getTime();
  const out: ActivityEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const ts = new Date(base - minutesAgo * 60_000 + i * 1000).toISOString();
    out.push({
      id: `id-${i}`,
      ts,
      agent: 'claude',
      shellIndex: 0,
      kind: 'tool',
      tool: 'Edit',
      target: `src/f${i}.ts`,
    });
  }
  return out;
}

function manyChats(count: number, minutesAgo: number, baseIso: string): ChatEntry[] {
  const base = new Date(baseIso).getTime();
  const out: ChatEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const ts = new Date(base - minutesAgo * 60_000 + i * 1000).toISOString();
    out.push({
      id: `c-${i}`,
      ts,
      from: { device: 'd0', shell: 0, agent: 'human' },
      to: [{ agent: 'claude' }],
      body: `msg ${i}`,
    });
  }
  return out;
}

const NOW = () => new Date('2026-11-25T14:00:00.000Z');

let tmp = '';
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'pick-')); });
afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe('pickStoryWindowMinutes', () => {
  it('uses the smallest window when there is already enough activity in the last 15 min', () => {
    seedActivity(tmp, manyEvents(MIN_EVENTS_FOR_STORY, 5, '2026-11-25T14:00:00.000Z'));
    const pick = pickStoryWindowMinutes({ projectPath: tmp, now: NOW });
    expect(pick.minutes).toBe(15);
    expect(pick.expanded).toBe(false);
    expect(pick.sawCap).toBe(false);
    expect(pick.events).toBeGreaterThanOrEqual(MIN_EVENTS_FOR_STORY);
  });

  it('expands when the 15-min window is thin but the last 4 hours are enough', () => {
    // 10 events in the last 10 min — below the 50 threshold.
    // Plus 45 events ~2 hours ago — adding up to ≥50 in the 4-hour window.
    seedActivity(tmp, [
      ...manyEvents(10, 10, '2026-11-25T14:00:00.000Z'),
      ...manyEvents(45, 120, '2026-11-25T14:00:00.000Z'),
    ]);
    const pick = pickStoryWindowMinutes({ projectPath: tmp, now: NOW });
    expect(pick.minutes).toBe(240);
    expect(pick.expanded).toBe(true);
    expect(pick.events).toBeGreaterThanOrEqual(MIN_EVENTS_FOR_STORY);
  });

  it('meets the threshold on chat alone (≥5 messages)', () => {
    seedActivity(tmp, []);
    seedChat(tmp, manyChats(MIN_CHAT_FOR_STORY, 10, '2026-11-25T14:00:00.000Z'));
    const pick = pickStoryWindowMinutes({ projectPath: tmp, now: NOW });
    expect(pick.minutes).toBe(15);
    expect(pick.chat).toBeGreaterThanOrEqual(MIN_CHAT_FOR_STORY);
  });

  it('walks all the way to 7 days when nothing meets the threshold', () => {
    // A handful of events 2 days ago — below both thresholds at every step
    // up to and including 72h; at 7d still below 50 events, so the picker
    // returns the largest step (7 days) with sawCap=true.
    seedActivity(tmp, manyEvents(5, 60 * 48, '2026-11-25T14:00:00.000Z'));
    const pick = pickStoryWindowMinutes({ projectPath: tmp, now: NOW });
    expect(pick.minutes).toBe(WINDOW_LADDER_MINUTES[WINDOW_LADDER_MINUTES.length - 1]);
    expect(pick.sawCap).toBe(true);
    expect(pick.expanded).toBe(true);
  });

  it('returns the smallest step with zeros for a project with no logs', () => {
    const pick = pickStoryWindowMinutes({ projectPath: tmp, now: NOW });
    expect(pick.events).toBe(0);
    expect(pick.chat).toBe(0);
    expect(pick.minutes).toBe(WINDOW_LADDER_MINUTES[WINDOW_LADDER_MINUTES.length - 1]);
    expect(pick.sawCap).toBe(true);
  });

  it('honours a custom ladder (for tests)', () => {
    seedActivity(tmp, manyEvents(60, 30, '2026-11-25T14:00:00.000Z'));
    const pick = pickStoryWindowMinutes({ projectPath: tmp, now: NOW, ladder: [10, 60] });
    // 60 events sit at the 30-min mark — the 10-min window has none, the
    // 60-min window has 60.
    expect(pick.minutes).toBe(60);
    expect(pick.expanded).toBe(true);
  });
});
