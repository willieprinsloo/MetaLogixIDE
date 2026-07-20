#!/usr/bin/env node
/**
 * Rasterises build/icon.svg into every size the platforms want, then bundles
 * them into build/icon.icns (macOS) and build/icon.ico (Windows). electron-
 * builder picks these up automatically once they exist next to the config.
 *
 * Requirements:
 *   - `magick` (ImageMagick 7)  for SVG → PNG rasterisation and .ico assembly
 *   - `iconutil` (bundled with macOS) for .icns assembly
 *
 * Usage: `pnpm gen:icons` or `node scripts/gen-icons.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const src = resolve(root, 'build/icon.svg');
const buildDir = resolve(root, 'build');
const iconsetDir = resolve(buildDir, 'icon.iconset');

if (!existsSync(src)) {
  console.error(`✗ ${src} not found. Create it (SVG, ideally 1024×1024) and re-run.`);
  process.exit(1);
}

// Sanity-check tooling before we rasterise anything.
function need(bin) {
  try { execFileSync('which', [bin], { stdio: 'ignore' }); }
  catch { console.error(`✗ Required tool '${bin}' not on PATH.`); process.exit(1); }
}
need('magick');
if (process.platform === 'darwin') need('iconutil');

function png(size, out) {
  execFileSync('magick', [
    '-background', 'none',
    '-density', String(size * 2),
    src, '-resize', `${size}x${size}`,
    out,
  ], { stdio: 'inherit' });
}

// macOS iconset layout — iconutil requires exactly these names.
const macSizes = [
  { name: 'icon_16x16.png',       size:   16 },
  { name: 'icon_16x16@2x.png',    size:   32 },
  { name: 'icon_32x32.png',       size:   32 },
  { name: 'icon_32x32@2x.png',    size:   64 },
  { name: 'icon_128x128.png',     size:  128 },
  { name: 'icon_128x128@2x.png',  size:  256 },
  { name: 'icon_256x256.png',     size:  256 },
  { name: 'icon_256x256@2x.png',  size:  512 },
  { name: 'icon_512x512.png',     size:  512 },
  { name: 'icon_512x512@2x.png',  size: 1024 },
];

console.log('▸ Rasterising to iconset PNGs…');
rmSync(iconsetDir, { recursive: true, force: true });
mkdirSync(iconsetDir, { recursive: true });
for (const { name, size } of macSizes) {
  console.log(`  ${size.toString().padStart(4)}×${size}  →  ${name}`);
  png(size, resolve(iconsetDir, name));
}

// Windows .ico: multi-resolution single file. 16..256 is the standard range.
const winSizes = [16, 24, 32, 48, 64, 128, 256];
console.log('\n▸ Building Windows .ico (build/icon.ico)…');
const tmpDir = resolve(buildDir, '.ico-tmp');
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir);
const winPngs = winSizes.map((s) => {
  const p = resolve(tmpDir, `icon-${s}.png`);
  png(s, p);
  return p;
});
execFileSync('magick', [...winPngs, resolve(buildDir, 'icon.ico')], { stdio: 'inherit' });
rmSync(tmpDir, { recursive: true, force: true });

// Also emit a bare PNG (Linux + electron-builder fallback).
console.log('\n▸ Emitting Linux/PNG fallback (build/icon.png)…');
png(512, resolve(buildDir, 'icon.png'));

// macOS .icns via Apple's iconutil — must run on macOS.
if (process.platform === 'darwin') {
  console.log('\n▸ Building macOS .icns (build/icon.icns)…');
  execFileSync('iconutil', [
    '-c', 'icns', iconsetDir,
    '-o', resolve(buildDir, 'icon.icns'),
  ], { stdio: 'inherit' });
  rmSync(iconsetDir, { recursive: true, force: true });
} else {
  console.log('\n⚠ Skipping .icns (only iconutil on macOS can produce it).');
  console.log('  The .iconset directory has been kept at build/icon.iconset');
  console.log('  so a Mac in your pipeline can run `iconutil -c icns` on it.');
}

console.log('\n✓ Done. Artifacts:');
for (const f of ['icon.icns', 'icon.ico', 'icon.png']) {
  const p = resolve(buildDir, f);
  if (existsSync(p)) console.log(`  build/${f}`);
}
