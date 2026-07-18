#!/usr/bin/env node
// Deterministic fake `claude` CLI used in tests. Echoes stdin lines and
// responds to /model. On --continue, prints a "resumed" banner.
const args = process.argv.slice(2);
const isContinue = args.includes('--continue');
process.stdout.write(isContinue ? 'mock-claude resumed\n> ' : 'mock-claude ready\n> ');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  const line = String(chunk).trim();
  if (line.startsWith('/model ')) {
    process.stdout.write(`model set to ${line.slice(7)}\n> `);
  } else if (line === 'exit' || line === '/quit') {
    process.exit(0);
  } else {
    process.stdout.write(`echo: ${line}\n> `);
  }
});
