import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const resolvePackage = createRequire(import.meta.url).resolve;
const packageDirectory = dirname(resolvePackage('@gespenst/core/package.json'));
const wrapperDirectory = dirname(resolvePackage('@gespenst/xterm/package.json'));
const worker = 'new Worker(new URL(``+new URL(`assets/terminal-worker-CfcHI8XP.js`,import.meta.url).href,``+import.meta.url),{type:`module`,name:`gespenst`})';
const workerDisabled = '(() => { throw new Error("Ghostty workers are disabled"); })()';
const assets = ['ghostty-vt.wasm', 'ghostty-callbacks.wasm'].map(file =>
  [`new URL(\`\`+new URL(\`../${file}\`,import.meta.url).href,\`\`+import.meta.url)`, 'new URL("about:blank")'] as const,
);

/** Prevent the pinned wrapper's unused default asset paths from emitting a second WASM or worker. */
export function ghosttyCorePolicy() {
  const paths = new Map([
    [realpathSync(join(wrapperDirectory, 'dist/index.js')).replaceAll('\\', '/'), {
      digest: 'd4e3cc6d01e5366fbda95275cd0c320531d5402def385fd892dc6a18c7fc3dfd',
      replacements: [],
    }],
    [realpathSync(join(packageDirectory, 'dist/index.js')).replaceAll('\\', '/'), {
      digest: 'd8324eed1637589a663a7dad207d8a23f7cbd1b5e7355891a07616f9c8bdb9e1',
      replacements: [[worker, workerDisabled] as const],
    }],
    [realpathSync(join(packageDirectory, 'dist/chunks/core-DxIkt0Aw.js')).replaceAll('\\', '/'), {
      digest: '30bf6727572ad3596111fda768e93ff4e08b93566bd1e94b3ff1a3eaec30f822',
      replacements: assets,
    }],
  ]);
  return {
    name: 'metaide:desktop-ghostty-core-policy',
    enforce: 'pre' as const,
    config() { return { optimizeDeps: { exclude: ['@gespenst/core', '@gespenst/xterm'] } }; },
    transform(code: string, id: string) {
      const policy = paths.get(id);
      if (!policy) return;
      if (createHash('sha256').update(code).digest('hex') !== policy.digest) throw new Error(`Unexpected Ghostty JavaScript digest: ${id}`);
      if (policy.replacements.length === 0) return;
      for (const [before, after] of policy.replacements) {
        if (code.split(before).length !== 2) throw new Error('Unrecognized Ghostty asset reference');
        code = code.replace(before, after);
      }
      return { code, map: null };
    },
    generateBundle(_options: unknown, bundle: Record<string, unknown>) {
      if (Object.keys(bundle).some(file => /ghostty-.*\.wasm$|terminal-worker-[\w-]+\.js$/u.test(file))) {
        throw new Error('Unexpected loose Ghostty WASM or worker in renderer output');
      }
    },
  };
}
