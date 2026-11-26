import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const bundleExtensions = new Set(['.app', '.appex', '.framework', '.xpc']);
const machMagic = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe,
  0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
]);

/** @param {string} path @returns {boolean} */
function isMachFile(path) {
  if (!['.node', '.dylib'].includes(extname(path)) && (statSync(path).mode & 0o111) === 0) return false;
  const fd = openSync(path, 'r');
  try {
    const magic = Buffer.alloc(4);
    return readSync(fd, magic, 0, magic.length, 0) === magic.length && machMagic.has(magic.readUInt32BE(0));
  } finally {
    closeSync(fd);
  }
}

/** @param {string} contents @returns {string[]} */
function nestedCode(contents) {
  const paths = [];
  const directories = [contents];
  for (const directory of directories) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
        if (bundleExtensions.has(extname(path))) paths.push(path);
      } else if (entry.isFile() && isMachFile(path)) {
        paths.push(path);
      }
    }
  }
  // Sign inside out so signing a child never invalidates its parent's seal.
  return paths.sort((left, right) => right.length - left.length);
}

/**
 * Seal macOS app bundles for native notifications without using a keychain identity.
 * @param {Pick<import('app-builder-lib').AfterPackContext, 'electronPlatformName' | 'appOutDir' | 'packager'>} context
 * @returns {void}
 */
export default function signMacBundle(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  for (const code of [...nestedCode(join(app, 'Contents')), app]) {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', code]);
  }
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  console.log(`Verified ad-hoc signature: ${app}`);
}
