// Ported from BotOffice windows/test/engine-cli.test.js.
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { npmCli } from '@main/group-chat/engines/cli';

const npmDir = mkdtempSync(join(tmpdir(), 'npmcli-'));
mkdirSync(join(npmDir, 'node_modules', '@google', 'gemini-cli'), { recursive: true });
writeFileSync(join(npmDir, 'node_modules', '@google', 'gemini-cli', 'package.json'), JSON.stringify({ bin: { gemini: 'bundle/gemini.js' } }));

describe('npmCli', () => {
  it('on Windows an npm CLI runs as node + its script', () => {
    expect(npmCli('@google/gemini-cli', 'gemini', { platform: 'win32', npmDir })).toEqual(['node', join(npmDir, 'node_modules', '@google', 'gemini-cli', 'bundle/gemini.js')]);
  });

  it('on Windows without the package it falls back to an .exe on PATH', () => {
    expect(npmCli('@openai/codex', 'codex', { platform: 'win32', npmDir })).toEqual(['codex.exe']);
  });

  it('elsewhere the command name is used as is', () => {
    expect(npmCli('@openai/codex', 'codex', { platform: 'linux', npmDir })).toEqual(['codex']);
  });
});
