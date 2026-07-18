import { describe, it, expect } from 'vitest';
import { discoverProjects } from '@main/domain/discovery';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setupRoot() {
  const root = mkdtempSync(join(tmpdir(), 'disc-'));
  mkdirSync(join(root, 'proj-git'));      mkdirSync(join(root, 'proj-git/.git'));
  mkdirSync(join(root, 'proj-node'));     writeFileSync(join(root, 'proj-node/package.json'), '{}');
  mkdirSync(join(root, 'proj-py'));       writeFileSync(join(root, 'proj-py/pyproject.toml'), '');
  mkdirSync(join(root, 'proj-go'));       writeFileSync(join(root, 'proj-go/go.mod'), '');
  mkdirSync(join(root, 'proj-rust'));     writeFileSync(join(root, 'proj-rust/Cargo.toml'), '');
  mkdirSync(join(root, 'proj-mp'));       writeFileSync(join(root, 'proj-mp/.metaproject.yaml'), '');
  mkdirSync(join(root, 'not-a-project')); // no markers
  return root;
}

describe('discoverProjects', () => {
  it('identifies projects by any marker', () => {
    const root = setupRoot();
    const projects = discoverProjects(root, 1);
    const names = projects.map(p => p.name).sort();
    expect(names).toEqual(['proj-git', 'proj-go', 'proj-mp', 'proj-node', 'proj-py', 'proj-rust']);
  });

  it('ignores folders without markers', () => {
    const root = setupRoot();
    const projects = discoverProjects(root, 1);
    expect(projects.map(p => p.name)).not.toContain('not-a-project');
  });

  it('reports which markers matched', () => {
    const root = setupRoot();
    const p = discoverProjects(root, 1).find(x => x.name === 'proj-git')!;
    expect(p.markers).toContain('.git');
  });

  it('depth=2 recurses one extra level', () => {
    const root = mkdtempSync(join(tmpdir(), 'disc2-'));
    mkdirSync(join(root, 'monorepo'));
    mkdirSync(join(root, 'monorepo/packages'));
    mkdirSync(join(root, 'monorepo/packages/a'));
    writeFileSync(join(root, 'monorepo/packages/a/package.json'), '{}');
    const projects = discoverProjects(root, 2);
    expect(projects.map(p => p.name)).toContain('a');
  });
});
