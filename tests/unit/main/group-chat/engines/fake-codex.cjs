#!/usr/bin/env node
'use strict';
// Stand-in for `codex` in group-chat engine tests (ported from BotOffice) (cfg.codex = ['node', '<this file>']).
//   --version → "codex-cli 0.0.0-fake"
//   exec …    → reads the prompt from stdin, appends {argv, cwd, stdin, env} to FAKE_CODEX_LOG,
//               waits FAKE_CODEX_DELAY_MS, then prints `--json` events: a thread (new id, or the
//               resumed one), a command, a file change, and "codex: <prompt>" as the answer.
//               FAKE_CODEX_FAIL=<text> ends with turn.failed instead.
const fs = require('fs');

const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('codex-cli 0.0.0-fake\n'); process.exit(0); }

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv: args, cwd: process.cwd(), stdin, }) + '\n');
  const resumed = args[1] === 'resume' ? args[args.length - 2] : null;
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  setTimeout(() => {
    out({ type: 'thread.started', thread_id: resumed || 'fake-thread-1' });
    out({ type: 'turn.started' });
    if (process.env.FAKE_CODEX_FAIL) {
      out({ type: 'turn.failed', error: { message: process.env.FAKE_CODEX_FAIL } });
      process.exit(1);
    }
    out({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'dir' } });
    out({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'dir', exit_code: 0 } });
    out({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: `${process.cwd()}/notes.md`, kind: 'add' }] } });
    out({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: `codex: ${stdin}` } });
    out({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 7 } });
  }, Number(process.env.FAKE_CODEX_DELAY_MS || 0));
});
