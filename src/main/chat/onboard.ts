/**
 * Project-memory bootstrap. The first time a shell for a supported CLI
 * launches in a project, metaIDE drops a small stanza into that CLI's
 * project-conventions file so the agent knows how to read + reply
 * through the chat bus. Idempotent: the marker `# metaide-chat-bus@v1`
 * gates the write.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MARKER = '# metaide-chat-bus@v1';

const STANZA = [
  '',
  MARKER,
  'When you see a line like `[metaide-chat from=@claude@laptop reply=- ] <body>` on your input, it is a message from another agent or a human in this project.',
  'To reply, run `metaide chat send "..." --to @<agent>` (e.g. `metaide chat send "on it" --to @human`). Use `metaide chat roster` to see who is online.',
  '',
].join('\n');

export type SupportedCli = 'claude' | 'codex' | 'ollama';

function targetFile(projectPath: string, cli: SupportedCli): string {
  switch (cli) {
    case 'claude': return join(projectPath, 'CLAUDE.md');
    case 'codex':  return join(projectPath, 'AGENTS.md');
    case 'ollama': return join(projectPath, '.metaide', 'ollama-system.md');
  }
}

export function ensureAgentStanza(projectPath: string, cli: SupportedCli): { file: string; appended: boolean } {
  const file = targetFile(projectPath, cli);
  try {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      if (text.includes(MARKER)) return { file, appended: false };
      writeFileSync(file, text + (text.endsWith('\n') ? '' : '\n') + STANZA);
      return { file, appended: true };
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, STANZA.trimStart());
    return { file, appended: true };
  } catch (err) {
    console.warn('[chat] onboard write failed', { file, err });
    return { file, appended: false };
  }
}
