import { describe, it, expect } from 'vitest';
import { isAnsweringInput } from '@main/claude-status/answer-input';

describe('isAnsweringInput (AC7)', () => {
  it.each([
    ['Enter', '\r'],
    ['typed text then Enter', 'abc\r'],
    ['Enter inside a pasted chunk', 'line one\rline two'],
    ['a lone Esc', '\x1b'],
    ['Ctrl-C', '\x03'],
    ['digit 1', '1'],
    ['digit 5', '5'],
    ['digit 9', '9'],
  ])('%s answers', (_label, data) => {
    expect(isAnsweringInput(data)).toBe(true);
  });

  it.each([
    ['focus in report', '\x1b[I'],
    ['focus out report', '\x1b[O'],
    ['cursor position report', '\x1b[12;40R'],
    ['device attributes reply', '\x1b[?1;2c'],
    ['arrow up', '\x1b[A'],
    ['arrow down (application mode)', '\x1bOB'],
    ['Alt-x', '\x1bx'],
    ['a plain letter', 'a'],
    ['digit 0', '0'],
    ['two digits', '12'],
    ['a digit with trailing text', '1a'],
    ['Tab', '\t'],
    ['Space', ' '],
    ['Backspace', '\x7f'],
    ['a line feed alone', '\n'],
    ['Ctrl-U', '\x15'],
    ['Ctrl-D', '\x04'],
    ['two Escs', '\x1b\x1b'],
    ['the empty string', ''],
    ['a non-ASCII digit', '١'],
  ])('%s does not answer', (_label, data) => {
    expect(isAnsweringInput(data)).toBe(false);
  });
});
