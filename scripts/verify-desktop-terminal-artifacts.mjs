import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import provenance from '../resources/ghostty/PROVENANCE.json' with { type: 'json' };

const noticeDir = 'resources/ghostty';
const candidateKey = 'terminal/ghostty-view-engine.ts';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const expectedWasm = Object.values(provenance.wasm).map(({ sha256 }) => sha256).sort();
const ghosttyAsset = /(?:ghostty|gespenst|terminal-worker)/iu;

function localAsset(path) {
  if (typeof path !== 'string' || !/^assets\/[\w.-]+$/u.test(path)) throw new Error('Unexpected non-local renderer asset');
  return path;
}

function checkNotices(root) {
  for (const name of ['PROVENANCE.json', 'THIRD-PARTY-NOTICES.txt']) {
    let actual;
    try { actual = readFileSync(join(root, noticeDir, name)); }
    catch (cause) { throw new Error(`Missing Ghostty notice: ${name}`, { cause }); }
    if (!actual.equals(readFileSync(new URL(`../${noticeDir}/${name}`, import.meta.url)))) throw new Error(`Notices differ: ${name}`);
  }
}

function staticGraph(manifest, entryKey) {
  const keys = new Set();
  const files = new Set();
  const dynamic = new Set();
  function visit(key) {
    if (keys.has(key)) return;
    if (!Object.hasOwn(manifest, key)) throw new Error(`Unknown renderer graph entry: ${key}`);
    keys.add(key);
    const entry = manifest[key];
    files.add(localAsset(entry.file));
    for (const path of entry.css ?? []) files.add(localAsset(path));
    for (const key of entry.dynamicImports ?? []) dynamic.add(key);
    for (const key of entry.imports ?? []) visit(key);
  }
  visit(entryKey);
  return { files, dynamic };
}

function checkColdPage(renderer, manifest, key) {
  const graph = staticGraph(manifest, key);
  if (!manifest[key].isEntry || [...graph.files].some(file => ghosttyAsset.test(file))) throw new Error(`Ghostty in cold renderer graph: ${key}`);
  const html = readFileSync(join(renderer, key), 'utf8');
  const resources = [];
  for (const tag of html.matchAll(/<(?:script|link)\b[^>]*>/giu)) {
    const ref = /\b(?:src|href)\s*=\s*["']([^"']+)["']/iu.exec(tag[0]);
    if (!ref?.[1]?.startsWith('./')) throw new Error(`Unexpected non-local resource in ${key}`);
    const file = localAsset(ref[1].slice(2));
    if (ghosttyAsset.test(file) || !graph.files.has(file)) throw new Error(`Unexpected asset in cold HTML: ${file}`);
    resources.push(file);
  }
  if (!resources.includes(manifest[key].file)) throw new Error(`Missing entry in cold HTML: ${key}`);
  for (const file of graph.files) {
    if (/atob\(["']AGFzbQ/u.test(readFileSync(join(renderer, file), 'utf8'))) throw new Error(`WASM in cold renderer graph: ${file}`);
  }
  return graph;
}

/** Inspect an ASAR through Electron's read-only filesystem view, or an extracted app root. */
export function verifyTerminalPackage(root) {
  checkNotices(root);
  const renderer = join(root, 'out', 'renderer');
  const manifest = JSON.parse(readFileSync(join(renderer, 'asset-manifest.json'), 'utf8'));
  const main = checkColdPage(renderer, manifest, 'index.html');
  checkColdPage(renderer, manifest, 'p2pWorker.html');
  const entry = Object.hasOwn(manifest, candidateKey) ? manifest[candidateKey] : undefined;
  if (!entry?.isDynamicEntry || !main.dynamic.has(candidateKey)) throw new Error('Missing lazy Ghostty entry');
  const js = localAsset(entry.file);
  const assets = readdirSync(join(renderer, 'assets'));
  if (readdirSync(renderer, { recursive: true }).some(name => /\.wasm$|terminal-worker-/iu.test(name))) throw new Error('Unexpected loose WASM or worker');
  const candidates = assets.filter(name => /^ghostty-view-engine-.*\.js$/u.test(name));
  if (candidates.length !== 1 || js !== `assets/${candidates[0]}`) throw new Error('Expected one Ghostty JavaScript chunk');
  const bundle = readFileSync(join(renderer, js), 'utf8');
  const wasm = Array.from(bundle.matchAll(/\batob\(["'](AGFzbQ[A-Za-z0-9+/=]+)["']\)/gu), match => sha256(Buffer.from(match[1], 'base64'))).sort();
  if (wasm.length !== expectedWasm.length) throw new Error('Expected exactly 2 embedded Ghostty WASM modules');
  if (wasm.some((digest, index) => digest !== expectedWasm[index])) throw new Error('Unexpected Ghostty WASM digests');
  if (entry.css?.length !== 1) throw new Error('Expected one Ghostty stylesheet');
  const css = localAsset(entry.css[0]);
  const cssBytes = readFileSync(join(renderer, css));
  if (!cssBytes.includes('[data-terminal-engine-host="ghostty"]') && !cssBytes.includes('[data-terminal-engine-host=ghostty]')) {
    throw new Error('Missing Ghostty stylesheet scope');
  }
  return { candidateJavaScript: { file: js, sha256: sha256(bundle) }, candidateStylesheet: { file: css, sha256: sha256(cssBytes) }, wasmSha256: wasm };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [, , root, distribution] = process.argv;
  if (!root || !process.versions.electron) throw new Error('Usage: ELECTRON_RUN_AS_NODE=1 electron scripts/verify-desktop-terminal-artifacts.mjs <app.asar> [distribution]');
  const rawFs = createRequire(import.meta.url)('original-fs');
  async function fileHash(path) {
    const hash = createHash('sha256');
    for await (const bytes of rawFs.createReadStream(path)) hash.update(bytes);
    return hash.digest('hex');
  }
  const result = { ...verifyTerminalPackage(root), asarSha256: await fileHash(root) };
  if (distribution) result.distributionSha256 = await fileHash(distribution);
  console.log(JSON.stringify(result, null, 2));
}
