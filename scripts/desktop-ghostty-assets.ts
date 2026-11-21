import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import postcss from 'postcss';
import { GHOSTTY_HOST_SELECTOR } from '../src/shared/terminal-engine';

const resolvePackage = createRequire(import.meta.url).resolve;
const assets = {
  vt: ['@gespenst/core/ghostty-vt.wasm', 'e40fe5d53319c4d9ab9283802e2844ded9ca86eba52894f865fc67a849620166'],
  callbacks: ['@gespenst/core/ghostty-callbacks.wasm', 'b1469aa7900b0c10f272bcb150d5c815def2cd536bf734d9e46ac6c50eea2edb'],
  stylesheet: ['@gespenst/xterm/css/xterm.css', 'e3257903000058c3958ade2add3d7ef089f144686690f02ff1402d6a2fea6f82'],
} as const;
const virtualPrefix = 'virtual:metaide-ghostty-';

/** Fail the build rather than emit unexpected candidate input. */
export function readVerifiedGhosttyAsset(asset: keyof typeof assets, read: (path: string) => Buffer = readFileSync): Buffer {
  const [id, expected] = assets[asset];
  let bytes: Buffer;
  try { bytes = read(resolvePackage(id)); }
  catch (cause) { throw new Error(`Missing Ghostty ${asset}`, { cause }); }
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Ghostty ${asset} digest mismatch`);
  return bytes;
}

/** The reviewed stylesheet uses ordinary rules only. Reject global at-rules instead of publishing them. */
export function scopeGhosttyStyles(css: string): string {
  const sheet = postcss.parse(css);
  sheet.walkAtRules(rule => { throw new Error(`Unexpected Ghostty CSS at-rule: ${rule.name}`); });
  sheet.walkRules(rule => { rule.selectors = rule.selectors.map(selector => `${GHOSTTY_HOST_SELECTOR} ${selector}`); });
  return sheet.toString();
}

function recognize(id: string): 'vt' | 'callbacks' | undefined {
  if (id === `${virtualPrefix}vt`) return 'vt';
  if (id === `${virtualPrefix}callbacks`) return 'callbacks';
  return undefined;
}

/** Emit verified WASM as JavaScript inside the caller's lazy chunk. Vite need not fetch a .wasm URL. */
export function desktopGhosttyAssets() {
  const stylesheet = realpathSync(resolvePackage(assets.stylesheet[0]));
  return {
    name: 'metaide:desktop-ghostty-assets',
    enforce: 'pre' as const,
    resolveId(id: string) {
      if (id === assets.stylesheet[0]) return stylesheet;
      if (recognize(id)) return `\0${id}`;
    },
    load(id: string) {
      if (!id.startsWith('\0')) return;
      const asset = recognize(id.slice(1));
      if (!asset) return;
      const encoded = readVerifiedGhosttyAsset(asset).toString('base64');
      return `export default Uint8Array.from(atob(${JSON.stringify(encoded)}), byte => byte.charCodeAt(0));`;
    },
    transform(css: string, id: string) {
      if (id !== stylesheet) return;
      const verified = readVerifiedGhosttyAsset('stylesheet').toString('utf8');
      if (css !== verified) throw new Error('Ghostty stylesheet changed during build');
      return { code: scopeGhosttyStyles(css), map: null };
    },
  };
}
