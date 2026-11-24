import { describe, it, expect } from 'vitest';
import { parseMentions, formatMention } from '@shared/chat-mention';

describe('parseMentions', () => {
  it('bare agent', () => {
    expect(parseMentions('@claude hi')).toEqual([{ agent: 'claude' }]);
  });
  it('shell-qualified', () => {
    expect(parseMentions('hey @codex#2')).toEqual([{ agent: 'codex', shell: 2 }]);
  });
  it('device-qualified', () => {
    expect(parseMentions('@claude@mac-mini?')).toEqual([{ agent: 'claude', device: 'mac-mini' }]);
  });
  it('shell + device', () => {
    expect(parseMentions('@claude#1@laptop here')).toEqual([{ agent: 'claude', shell: 1, device: 'laptop' }]);
  });
  it('@all expands to the broadcast marker', () => {
    expect(parseMentions('@all go')).toEqual([{ agent: 'all' }]);
  });
  it('@human is addressable', () => {
    expect(parseMentions('@human ok')).toEqual([{ agent: 'human' }]);
  });
  it('no mention ⇒ empty list', () => {
    expect(parseMentions('just text')).toEqual([]);
  });
  it('duplicate mentions dedupe', () => {
    expect(parseMentions('@claude @claude@laptop @claude')).toEqual([
      { agent: 'claude' },
      { agent: 'claude', device: 'laptop' },
    ]);
  });
});

describe('formatMention', () => {
  it('composes @agent#shell@device', () => {
    expect(formatMention({ agent: 'codex', shell: 2, device: 'mac-mini' })).toBe('@codex#2@mac-mini');
  });
  it('omits optional parts', () => {
    expect(formatMention({ agent: 'claude' })).toBe('@claude');
    expect(formatMention({ agent: 'claude', shell: 1 })).toBe('@claude#1');
    expect(formatMention({ agent: 'claude', device: 'laptop' })).toBe('@claude@laptop');
  });
});
