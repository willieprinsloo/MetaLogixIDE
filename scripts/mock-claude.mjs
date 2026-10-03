#!/usr/bin/env node
// Deterministic fake `claude` CLI used in tests. Echoes stdin lines and
// responds to /model, /size, /flood and /truecolor-top. On --continue,
// prints a "resumed" banner.
// `/size` prints the PTY's current columns x rows as seen by this process
// (updated on SIGWINCH), so tests can check what size the PTY really has.
// `/flood [kb]` mimics how Claude Code's TUI draws: see flood() below.
// `/truecolor-top` draws a screen whose first cell is truecolor: see truecolorTop().
//
// Claude Code hook emulation (docs/specs/claude-code-notifications.md,
// amended docs/specs/claude-status-dots.md §R1/R2 background work):
// when launched with `--settings <path>`, reads the app-owned hook settings
// file the same way real Claude does and POSTs JSON hook events to its
// `http` hook's url. Headers are built from the hook's header templates,
// substituting `$VAR` only for names listed in `allowedEnvVars` (mirrors
// Claude: it never leaks arbitrary env into a hook header). POSTs are
// fire-and-forget — a failure is swallowed, never surfaced to the user or
// the caller, because Claude's own hook delivery must never block a turn.
// `/hook-stop` posts a plain Stop (no background_tasks). `/hook-stop-bg [n]`
// posts a Stop with `n` (default 1) fake `background_tasks` entries — real
// Claude sends this while paused waiting on its own background work, which
// must NOT count as "finished" (AC24-AC26). `/hook-stop-crons` posts a Stop
// with an empty `background_tasks` but a non-empty `session_crons`, which
// must still count as "finished" (AC27, `session_crons` is never read).
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const isContinue = args.includes('--continue');

// ─── Hook settings (only present when launched with --settings <path>) ────
// `settingsCount` is how many --settings occurrences this process actually
// received in its own argv (as opposed to the app's pre-decoration record of
// what it MEANT to launch, which never contains an injected one — AC8) —
// the ground truth for "was this spawn decorated, and exactly once".
const settingsCount = args.filter((a) => a === '--settings' || a.startsWith('--settings=')).length;
const settingsFlagIdx = args.findIndex((a) => a === '--settings' || a.startsWith('--settings='));
const settingsPath = settingsFlagIdx === -1 ? null : (args[settingsFlagIdx].startsWith('--settings=')
  ? args[settingsFlagIdx].slice('--settings='.length)
  : args[settingsFlagIdx + 1]);
let hookConfig = null;
if (settingsPath) {
  try {
    const doc = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const hook = doc?.hooks?.Notification?.[0]?.hooks?.[0];
    if (hook && typeof hook.url === 'string') {
      hookConfig = { url: hook.url, headers: hook.headers ?? {}, allowedEnvVars: hook.allowedEnvVars ?? [] };
    }
  } catch {
    // No settings file, malformed JSON, or unreadable — hooks stay disabled,
    // same as when Claude's own hook delivery has nothing to talk to.
  }
}

/** Resolves `$VAR` in a header template from process.env, only for allow-listed names. */
function resolveHeaderTemplate(template, allowedEnvVars) {
  return template.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name) => (
    allowedEnvVars.includes(name) ? (process.env[name] ?? '') : whole
  ));
}

/** Fire-and-forget POST of one Claude Code hook event; a no-op without hook config. */
function postHook(body) {
  if (!hookConfig) return;
  const headers = { 'Content-Type': 'application/json' };
  for (const [key, template] of Object.entries(hookConfig.headers)) {
    headers[key] = resolveHeaderTemplate(template, hookConfig.allowedEnvVars);
  }
  fetch(hookConfig.url, { method: 'POST', headers, body: JSON.stringify(body) }).catch(() => {});
}

// Text of the /flood footer. Tests match these exactly.
const INPUT_BOX = '| > INPUT-BOX-MARK';
const STATUS_PREFIX = 'STATUS-LINE-MARK model=mock tokens=';
// fg rgb(255,200,100), bg rgb(100,150,200): 35 characters before the final 'm'.
const TRUECOLOR_SGR = '\x1b[38;2;255;200;100;48;2;100;150;200m';
const pad6 = (n) => String(n).padStart(6, '0');

/**
 * Full-screen TUI redraw that only ever patches cells, like Claude Code (Ink):
 *   1. clear the screen, draw an input box on row rows-1 and a status line on
 *      the last row — once;
 *   2. write more than `kb` KiB of content lines into rows 1..rows-2 with
 *      absolute cursor addressing (cycling, never scrolling — no newline is
 *      ever written), patching only the status line's token counter digits
 *      every 50 lines;
 *   3. write `FLOOD-END lines=<n> bytes=<b> size=<cols>x<rows>` on row 1 and
 *      leave the cursor at the end of it.
 * Nothing is printed afterwards (no prompt), so the screen stays exactly as
 * drawn: the input box and status line text exist only in the first few
 * bytes of the flood, far outside a raw tail of the last 256 KiB.
 */
function flood(kb) {
  const cols = process.stdout.columns || 80;
  const rows = Math.max(3, process.stdout.rows || 24);
  const width = Math.max(20, Math.min(cols - 1, 72));
  const contentRows = rows - 2;
  const counterCol = STATUS_PREFIX.length + 1;
  const target = kb * 1024;

  let bytes = 0;
  const emit = (s) => { bytes += s.length; process.stdout.write(s); };

  emit(
    '\x1b[2J\x1b[H' +
    `\x1b[${rows - 1};1H\x1b[2K${INPUT_BOX.slice(0, width)}` +
    `\x1b[${rows};1H\x1b[2K${(STATUS_PREFIX + pad6(0)).slice(0, width)}`,
  );

  let n = 0;
  while (bytes < target) {
    let chunk = '';
    for (let k = 0; k < 200; k++, n++) {
      const row = 1 + (n % contentRows);
      const text = `flood ${pad6(n)} `.padEnd(width, 'x');
      chunk += `\x1b[${row};1H\x1b[2K${text}`;
      if (n % 50 === 49) chunk += `\x1b[${rows};${counterCol}H${pad6(n + 1)}`;
    }
    emit(chunk);
  }
  // Final counter patch, then the end marker on row 1.
  emit(`\x1b[${rows};${counterCol}H${pad6(n)}`);
  emit(`\x1b[1;1H\x1b[2KFLOOD-END lines=${n} bytes=${bytes} size=${cols}x${rows}`);
}

/**
 * Clears screen and scrollback, then draws:
 *   row 1:    TRUECOLOR-TOP-MARK, its first cell with a truecolor fg AND bg
 *             (3-digit channels, so the SGR is longer than 32 characters);
 *   last row: `TRUECOLOR-FOOTER-MARK size=<cols>x<rows>`;
 * and parks the cursor at row 3, column 5. Nothing is printed afterwards.
 * A serialized snapshot of this screen starts with that long SGR.
 */
function truecolorTop() {
  const cols = process.stdout.columns || 80;
  const rows = Math.max(4, process.stdout.rows || 24);
  process.stdout.write(
    '\x1b[H\x1b[2J\x1b[3J' +
    `\x1b[1;1H${TRUECOLOR_SGR}TRUECOLOR-TOP-MARK\x1b[0m` +
    `\x1b[${rows};1HTRUECOLOR-FOOTER-MARK size=${cols}x${rows}` +
    '\x1b[3;5H',
  );
}

/** `/work <seconds>`: prints a dot every 500ms, to drive the generic "Command finished" heuristic. */
function work(seconds) {
  const total = Math.max(1, Math.round(seconds));
  let elapsed = 0;
  const timer = setInterval(() => {
    elapsed += 0.5;
    process.stdout.write('.');
    if (elapsed >= total) {
      clearInterval(timer);
      process.stdout.write(`\nwork done (${total}s)\n> `);
    }
  }, 500);
}

process.stdout.write(isContinue ? 'mock-claude resumed\n> ' : 'mock-claude ready\n> ');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  const line = String(chunk).trim();
  if (line.startsWith('/model ')) {
    process.stdout.write(`model set to ${line.slice(7)}\n> `);
  } else if (line === '/size') {
    process.stdout.write(`size: ${process.stdout.columns}x${process.stdout.rows}\n> `);
  } else if (line === '/flood' || line.startsWith('/flood ')) {
    const kb = Number(line.slice(6).trim());
    flood(Number.isFinite(kb) && kb > 0 ? kb : 512);
  } else if (line === '/truecolor-top') {
    truecolorTop();
  } else if (line === '/work' || line.startsWith('/work ')) {
    const secs = Number(line.slice(5).trim());
    work(Number.isFinite(secs) && secs > 0 ? secs : 10);
  } else if (line === '/hook-env') {
    const shell = process.env.METAIDE_HOOK_SHELL ?? 'none';
    const token = process.env.METAIDE_HOOK_TOKEN ?? 'none';
    process.stdout.write(`HOOK-ENV shell=${shell} token=${token}\n> `);
  } else if (line === '/hook-argv') {
    // How many --settings flags this process actually received, and which
    // path — ground truth for "was this spawn decorated, and exactly once",
    // as opposed to the app's own (pre-decoration, AC8) launch record.
    process.stdout.write(`HOOK-ARGV count=${settingsCount} path=${settingsPath ?? 'none'}\n> `);
  } else if (line === '/hook-stop') {
    postHook({ hook_event_name: 'Stop' });
    process.stdout.write('hook: Stop\n> ');
  } else if (line === '/hook-stop-bg' || line.startsWith('/hook-stop-bg ')) {
    // A Stop fired while Claude is only paused on its own background work —
    // must not be treated as "finished" (AC24-AC26).
    const rest = line.slice('/hook-stop-bg'.length).trim();
    const parsed = rest === '' ? 1 : Number(rest);
    const count = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
    const background_tasks = Array.from({ length: count }, (_, i) => ({ id: `bg-${i}`, type: 'shell', description: 'mock' }));
    postHook({ hook_event_name: 'Stop', background_tasks });
    process.stdout.write(`hook: Stop background_tasks=${count}\n> `);
  } else if (line === '/hook-stop-crons') {
    // `background_tasks` empty, `session_crons` non-empty — must still
    // count as "finished" (AC27: only `background_tasks` matters).
    postHook({ hook_event_name: 'Stop', background_tasks: [], session_crons: [{ id: 'c1' }] });
    process.stdout.write('hook: Stop session_crons\n> ');
  } else if (line.startsWith('/hook-notify')) {
    const rest = line.slice('/hook-notify'.length).trim();
    const spaceIdx = rest.indexOf(' ');
    const type = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
    const message = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1);
    postHook({ hook_event_name: 'Notification', notification_type: type, message: message || null });
    process.stdout.write(`hook: Notification ${type}\n> `);
  } else if (line.startsWith('/hook-raw ')) {
    // Arbitrary, non-Notification/Stop hook event name (e.g. SubagentStop) —
    // exercises the "ignored events" path without a notification_type.
    const eventName = line.slice('/hook-raw '.length).trim();
    postHook({ hook_event_name: eventName });
    process.stdout.write(`hook: ${eventName}\n> `);
  } else if (line === 'exit' || line === '/quit') {
    process.exit(0);
  } else {
    if (line !== '') postHook({ hook_event_name: 'UserPromptSubmit' });
    process.stdout.write(`echo: ${line}\n> `);
  }
});
