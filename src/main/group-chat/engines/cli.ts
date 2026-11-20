/**
 * How to start an npm-installed CLI without a shell. On Windows npm only leaves a .cmd shim, which
 * Node refuses to spawn without a shell, so run the package's own script with node instead.
 *   npmCli('@openai/codex', 'codex') → ['node', '…/node_modules/@openai/codex/bin/codex.js'] or ['codex']
 * Ported from BotOffice windows/engines/cli.js.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function npmCli(
  pkg: string,
  bin: string,
  { platform = process.platform, npmDir = process.env.APPDATA ? join(process.env.APPDATA, 'npm') : undefined }: { platform?: NodeJS.Platform; npmDir?: string } = {},
): string[] {
  if (platform !== 'win32' || !npmDir) return [bin];
  const dir = join(npmDir, 'node_modules', ...pkg.split('/'));
  try {
    const j = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
    const rel = typeof j.bin === 'string' ? j.bin : j.bin?.[bin];
    if (rel) return ['node', join(dir, rel)];
  } catch { /* not installed through npm here */ }
  return [`${bin}.exe`];
}
