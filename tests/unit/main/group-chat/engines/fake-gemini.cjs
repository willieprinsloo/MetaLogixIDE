#!/usr/bin/env node
'use strict';
// Stand-in for `gemini` in group-chat engine tests (ported from BotOffice) (cfg.gemini = ['node', '<this file>']).
//   --version → "0.0.0-fake"
//   otherwise → reads the message from stdin, appends {argv, cwd, stdin} to FAKE_GEMINI_LOG,
//               waits FAKE_GEMINI_DELAY_MS, prints stream-json: init (new or resumed session),
//               an edit, "gemini: <message>" in two deltas, and a success result.
//               FAKE_GEMINI_FAIL=<text> ends with an error result instead.
const fs = require('fs');

const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('0.0.0-fake\n'); process.exit(0); }

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', () => {
  if (process.env.FAKE_GEMINI_STDERR) { process.stderr.write(`${process.env.FAKE_GEMINI_STDERR}\n`); process.exit(41); }
  fs.appendFileSync(process.env.FAKE_GEMINI_LOG, JSON.stringify({ argv: args, cwd: process.cwd(), stdin }) + '\n');
  const i = args.indexOf('--resume');
  const sid = i >= 0 ? args[i + 1] : 'fake-gemini-session';
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  setTimeout(() => {
    out({ type: 'init', session_id: sid, model: 'gemini-fake' });
    out({ type: 'message', role: 'user', content: stdin });
    if (process.env.FAKE_GEMINI_FAIL) {
      out({ type: 'result', status: 'error', error: { type: 'Error', message: process.env.FAKE_GEMINI_FAIL }, stats: {} });
      process.exit(1);
    }
    out({ type: 'tool_use', tool_name: 'write_file', tool_id: 't1', parameters: { file_path: `${process.cwd()}/gem.md`, content: 'x' } });
    out({ type: 'tool_result', tool_id: 't1', status: 'success' });
    out({ type: 'message', role: 'assistant', content: 'gemini: ', delta: true });
    out({ type: 'message', role: 'assistant', content: stdin, delta: true });
    out({ type: 'result', status: 'success', stats: { input_tokens: 40, output_tokens: 4 } });
  }, Number(process.env.FAKE_GEMINI_DELAY_MS || 0));
});
