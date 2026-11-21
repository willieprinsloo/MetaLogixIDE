import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const packageDirectory = dirname(createRequire(import.meta.url).resolve('@gespenst/core/package.json'));
const worker = 'new Worker(new URL(``+new URL(`assets/terminal-worker-CfcHI8XP.js`,import.meta.url).href,``+import.meta.url),{type:`module`,name:`gespenst`})';
const workerDisabled = '(() => { throw new Error("Ghostty workers are disabled"); })()';
const assets = ['ghostty-vt.wasm', 'ghostty-callbacks.wasm'].map(file =>
  [`new URL(\`\`+new URL(\`../${file}\`,import.meta.url).href,\`\`+import.meta.url)`, 'new URL("about:blank")'] as const,
);

/** Prevent the pinned wrapper's unused default asset paths from emitting a second WASM or worker. */
export function ghosttyCorePolicy() {
  const paths = new Map([
    [realpathSync(join(packageDirectory, 'dist/index.js')), {
      digest: 'b7ae27a93862bb1b8d52682a3422a7443ac0c7e6be0ab03678b54ff9f8b4f6c8',
      replacements: [[worker, workerDisabled] as const],
    }],
    [realpathSync(join(packageDirectory, 'dist/chunks/core-DxIkt0Aw.js')), {
      digest: 'b096df05d9726cb980b1c2f0216d2e3d32fa408c174a62e8adc7a113be8e39b8',
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
      if (createHash('sha256').update(code).digest('hex') !== policy.digest) throw new Error('Unexpected Ghostty loader or worker glue');
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
