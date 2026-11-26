import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyTerminalPackage } from '../../scripts/verify-desktop-terminal-artifacts.mjs';

const resolve = createRequire(import.meta.url).resolve;
const bytes = ['ghostty-vt.wasm', 'ghostty-callbacks.wasm'].map(name => readFileSync(resolve(`@gespenst/core/${name}`)).toString('base64'));
const noticeNames = ['PROVENANCE.json', 'THIRD-PARTY-NOTICES.txt'];
const cold = 'assets/index-test.js';
const lazy = 'assets/ghostty-view-engine-test.js';
const stylesheet = 'assets/ghostty-view-engine-test.css';
const manifest = {
  'index.html': { file: cold, dynamicImports: ['terminal/ghostty-view-engine.ts'], isEntry: true },
  'p2pWorker.html': { file: 'assets/p2pWorker-test.js', isEntry: true },
  'terminal/ghostty-view-engine.ts': { file: lazy, css: [stylesheet], isDynamicEntry: true },
};

function payloads(...inputs) { return inputs.map(input => `atob(${JSON.stringify(input)})`).join('\n'); }

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'metaide-artifacts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function write(path, content) { writeFileSync(join(root, path), content); }
  mkdirSync(join(root, 'out/renderer/assets'), { recursive: true });
  mkdirSync(join(root, 'resources/ghostty'), { recursive: true });
  for (const name of noticeNames) write(`resources/ghostty/${name}`, readFileSync(new URL(`../../resources/ghostty/${name}`, import.meta.url)));
  function renderer(path, content) { write(`out/renderer/${path}`, content); }
  renderer('index.html', `<script type="module" src="./${cold}"></script>`);
  renderer('p2pWorker.html', '<script type="module" src="./assets/p2pWorker-test.js"></script>');
  renderer('asset-manifest.json', JSON.stringify(manifest));
  renderer(cold, `export const open = () => import('./${lazy.split('/').at(-1)}')`);
  renderer('assets/p2pWorker-test.js', '');
  renderer(lazy, payloads(...bytes));
  renderer(stylesheet, '[data-terminal-engine-host="ghostty"] .gespenst{position:relative}');
  return { root, write, renderer };
}

function verifiesAuthenticatedModules(t) {
  const { root } = fixture(t);
  const evidence = verifyTerminalPackage(root);
  assert.equal(evidence.candidateJavaScript.file, lazy);
  assert.match(evidence.candidateJavaScript.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(evidence.wasmSha256.length, 2);
}

const rejectionCases = [
  ['missing callbacks', f => f.renderer(lazy, payloads(bytes[0])), /exactly 2 embedded/u],
  ['duplicate module', f => f.renderer(lazy, payloads(...bytes, bytes[0])), /exactly 2 embedded/u],
  ['wrong module', f => f.renderer(lazy, payloads(bytes[0], 'AGFzbQAAAQ==')), /WASM digests/u],
  ['missing notices', f => unlinkSync(join(f.root, 'resources/ghostty/THIRD-PARTY-NOTICES.txt')), /Missing Ghostty notice/u],
  ['unverified notice', f => f.write('resources/ghostty/THIRD-PARTY-NOTICES.txt', 'MIT'), /Notices differ/u],
  ['second candidate chunk', f => f.renderer('assets/ghostty-view-engine-extra.js', payloads(...bytes)), /one Ghostty JavaScript/u],
  ['loose worker', f => f.renderer('assets/terminal-worker-run.js', ''), /loose WASM or worker/u],
  ['startup preload', f => f.renderer('index.html', `<script type="module" src="./${cold}"></script><link rel="modulepreload" href="./${lazy}">`), /cold HTML/u],
  ['network entry', f => f.renderer('index.html', '<script type="module" src="https://example.test/index.js"></script>'), /non-local/u],
  ['cold import', f => f.renderer('asset-manifest.json', JSON.stringify({ ...manifest, 'index.html': { ...manifest['index.html'], imports: ['terminal/ghostty-view-engine.ts'] } })), /cold renderer graph/u],
  ['cold embedded WASM', f => f.renderer(cold, payloads(bytes[0])), /WASM in cold renderer graph/u],
  ['unknown static dependency', f => f.renderer('asset-manifest.json', JSON.stringify({ ...manifest, 'p2pWorker.html': { ...manifest['p2pWorker.html'], imports: ['missing.ts'] } })), /Unknown renderer graph entry/u],
  ['missing lazy entry', f => f.renderer('asset-manifest.json', JSON.stringify({ ...manifest, 'index.html': { file: cold, isEntry: true } })), /Missing lazy Ghostty entry/u],
  ['missing cold entry resource', f => f.renderer('p2pWorker.html', '<title>No script</title>'), /Missing entry in cold HTML/u],
  ['unscoped stylesheet', f => f.renderer(stylesheet, '.gespenst{position:relative}'), /Missing Ghostty stylesheet scope/u],
];

export function registerDesktopTerminalArtifactCases(test) {
  test('checks the two authenticated modules and records the inspected chunk digest', verifiesAuthenticatedModules);
  for (const [name, change, message] of rejectionCases) {
    test(`rejects ${name}`, t => {
      const f = fixture(t);
      change(f);
      assert.throws(() => verifyTerminalPackage(f.root), message);
    });
  }
}
