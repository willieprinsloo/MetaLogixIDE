#!/usr/bin/env node
/**
 * Build every distributable metaIDE ships: macOS (arm64 + x64) and Windows
 * (x64, both NSIS installer and portable exe). Runs the electron-vite bundle
 * once, then electron-builder with all targets in a single invocation so
 * downloads (Electron binaries, Wine, winCodeSign) are cached and reused.
 *
 * Usage:
 *   pnpm dist:all           # all targets
 *   pnpm dist:all --mac     # macOS only
 *   pnpm dist:all --win     # Windows only
 *   pnpm dist:all --linux   # Linux only
 *
 * Windows builds from macOS require electron-builder's bundled Wine
 * (downloaded automatically the first time). Linux builds work anywhere.
 * macOS builds only work on macOS (Apple's codesign / dmg tooling is Mac-only).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(__dirname, '..');

const flags = new Set(process.argv.slice(2));
const wantMac   = flags.size === 0 || flags.has('--mac');
const wantWin   = flags.size === 0 || flags.has('--win');
const wantLinux = flags.has('--linux'); // opt-in — not part of the default set

if (process.platform !== 'darwin' && wantMac) {
  console.error('✗ macOS artifacts (dmg + notarised .app) can only be built on macOS.');
  console.error('  Re-run on a Mac, or pass --win / --linux to skip the mac target.');
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    console.log(`\n$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { stdio: 'inherit', cwd: repoRoot, ...opts });
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${cmd} exited with code ${code}`));
    });
    child.on('error', rejectPromise);
  });
}

async function main() {
  console.log('▸ Building electron-vite bundles…');
  await run('pnpm', ['exec', 'electron-vite', 'build']);

  const args = ['exec', 'electron-builder'];
  if (wantMac)   args.push('--mac', '--arm64', '--x64');
  if (wantWin)   args.push('--win', '--x64');
  if (wantLinux) args.push('--linux', '--x64');

  console.log(`\n▸ Packaging for: ${[wantMac && 'mac', wantWin && 'win', wantLinux && 'linux'].filter(Boolean).join(', ')}`);
  await run('pnpm', args);

  console.log('\n✓ Done. Artifacts in dist/:');
  const distDir = join(repoRoot, 'dist');
  if (existsSync(distDir)) {
    const entries = readdirSync(distDir);
    // Show only the shippable installers/archives, not the intermediate
    // per-arch output directories (mac-arm64/, mac/, win-unpacked/, …).
    const artifacts = entries
      .filter((f) => /\.(dmg|zip|exe|AppImage|deb|blockmap)$/.test(f))
      .map((f) => ({ f, size: statSync(join(distDir, f)).size }))
      .sort((a, b) => a.f.localeCompare(b.f));
    for (const { f, size } of artifacts) {
      const mb = (size / 1024 / 1024).toFixed(1);
      console.log(`  ${f.padEnd(48)} ${mb.padStart(6)} MB`);
    }
  }
}

// Ensure dist/ exists so relative-path listings don't blow up on a clean tree.
if (!existsSync(join(repoRoot, 'dist'))) mkdirSync(join(repoRoot, 'dist'));

main().catch((err) => {
  console.error(`\n✗ Build failed: ${err.message}`);
  process.exit(1);
});
