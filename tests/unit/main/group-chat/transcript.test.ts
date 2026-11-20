import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findGroupAnswer, readGroupAnswer } from '@main/group-chat/transcript';

const HEADER = '[Group chat "Group chat 1" in shop · round 1 of 4 · members: Main (Claude), Reviewer (GPT)]';
const ROUND = `${HEADER}\nSince your last message:\nYou: review the login\nReply to the group.`;

const user = (content: unknown) => JSON.stringify({ type: 'user', message: { role: 'user', content } });
const said = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const tool = () => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } });
const toolResult = () => user([{ type: 'tool_result', tool_use_id: 't1', content: 'file text' }]);
const jsonl = (...lines: string[]) => `${lines.join('\n')}\n`;

describe('findGroupAnswer', () => {
  it('answers with the assistant text after our message', () => {
    expect(findGroupAnswer(jsonl(user('earlier'), said('old'), user(ROUND), said('A')), HEADER)).toEqual({ status: 'answered', text: 'A' });
  });

  it('accepts our message as text parts too', () => {
    expect(findGroupAnswer(jsonl(user([{ type: 'text', text: ROUND }]), said('A')), HEADER)).toEqual({ status: 'answered', text: 'A' });
  });

  it("stops at Martin's own next prompt", () => {
    expect(findGroupAnswer(jsonl(user(ROUND), said('A'), user('my own question'), said('B')), HEADER)).toEqual({ status: 'answered', text: 'A' });
  });

  it('tool_result user lines do not end the answer', () => {
    expect(findGroupAnswer(jsonl(user(ROUND), said('A'), tool(), toolResult(), said('B')), HEADER)).toEqual({ status: 'answered', text: 'A\n\nB' });
  });

  it('not-yet when our message is not in the transcript', () => {
    expect(findGroupAnswer(jsonl(user('something else'), said('reply')), HEADER)).toEqual({ status: 'not-yet' });
  });

  it('not-yet when our message has no assistant text after it yet', () => {
    expect(findGroupAnswer(jsonl(user(ROUND), tool()), HEADER)).toEqual({ status: 'not-yet' });
  });

  it('uses the latest occurrence of the header', () => {
    expect(findGroupAnswer(jsonl(user(ROUND), said('first'), user(ROUND), said('second')), HEADER)).toEqual({ status: 'answered', text: 'second' });
  });

  it('skips a truncated last line and unparseable lines', () => {
    const text = `${jsonl(user(ROUND), 'not json', said('A'))}{"type":"assistant","message":{"content":[{"type":"te`;
    expect(findGroupAnswer(text, HEADER)).toEqual({ status: 'answered', text: 'A' });
  });

  it('tolerates Windows line endings', () => {
    expect(findGroupAnswer([user(ROUND), said('A')].join('\r\n'), HEADER)).toEqual({ status: 'answered', text: 'A' });
  });
});

describe('readGroupAnswer', () => {
  it('reads the file', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'tr-')), 't.jsonl');
    writeFileSync(p, jsonl(user(ROUND), said('A')));
    expect(await readGroupAnswer(p, HEADER)).toEqual({ status: 'answered', text: 'A' });
  });

  it('a missing file is not-yet, never a throw', async () => {
    expect(await readGroupAnswer(join(tmpdir(), 'no-such-dir-xyz', 't.jsonl'), HEADER)).toEqual({ status: 'not-yet' });
  });
});
