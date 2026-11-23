// Stand-in for `claude -p --output-format json`: answers with its own arguments and the round
// message it read on stdin, and a fresh session id (what --fork-session would make).
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  process.stdout.write(`${JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: `args: ${args.join(' ')}\ninput: ${input}`,
    session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  })}\n`);
});
