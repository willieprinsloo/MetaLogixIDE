/** Presentation contracts for identity, native selection, truthful saved state, warnings, and feedback. */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Project } from '@shared/types';
import { ProjectSettingsPanel } from '@renderer/components/ProjectSettingsPanel';
import type { ProjectDefaultAgentSnapshot } from '@renderer/project-default-agent-store';
import { PROJECT_SETTINGS_COPY as COPY } from '@renderer/project-settings-contract';

const project: Project = {
  id: 1, rootId: 1, name: 'Target project', path: '/projects/target', config: {},
  metaprojectProjectId: null, linkedChatChannelId: null, lastOpenedAt: null,
  pinned: false, hidden: false, firstLaunchedAt: null,
};

function ready(overrides: Partial<Extract<ProjectDefaultAgentSnapshot, { status: 'ready' }>> = {}): ProjectDefaultAgentSnapshot {
  return { status: 'ready', target: project, project, profiles: [
    { name: 'Codex', argv: ['codex'], scope: 'project' },
    { name: 'inherit:', argv: ['custom'], scope: 'global' },
    { name: 'Use global default', argv: ['other'], scope: 'project' },
  ], confirmedName: 'Codex', pendingName: 'Codex', feedback: { status: 'idle' }, ...overrides };
}

function render(snapshot: ProjectDefaultAgentSnapshot): string {
  return renderToStaticMarkup(<ProjectSettingsPanel snapshot={snapshot} onChoose={() => undefined}
    onReplaceCustomCommands={() => undefined} onRetry={() => undefined} />);
}

function select(html: string): string {
  const tag = html.match(/<select\b[^>]*>/)?.[0];
  expect(tag).toBeDefined();
  return tag ?? '';
}

describe('project settings presentation', () => {
  it('identifies the loaded target by name and full path with a native associated label', () => {
    const html = render(ready());
    expect(html).toContain(project.name);
    expect(html).toContain(project.path);
    const id = select(html).match(/\bid="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`for="${id}"`);
    expect(html).toContain(COPY.defaultAgentLabel);
    expect(select(html)).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(html).toMatch(/<option[^>]*selected=""[^>]*>Codex<\/option>/);
    expect(html).toContain(COPY.nextLaunchNotice);
  });

  it('uses noncolliding option values even when profile names resemble inheritance copy or encoding', () => {
    const html = render(ready({ confirmedName: 'inherit:', pendingName: 'inherit:' }));
    const values = [...html.matchAll(/<option\b[^>]*value="([^"]*)"/g)].map((match) => match[1]);
    expect(values).toHaveLength(5); // global, Terminal, three profiles
    expect(new Set(values).size).toBe(5);
    expect(html).toMatch(/<option[^>]*selected=""[^>]*>inherit:<\/option>/);
    expect(html).toContain('Use global default</option>');
  });

  it('keeps global inheritance enabled for an empty successful catalog', () => {
    const html = render(ready({ profiles: [], confirmedName: null, pendingName: null }));
    expect(select(html)).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(html.match(/<option\b/g)).toHaveLength(2); // global default and the built-in Terminal
    expect(html).toMatch(/<option[^>]*selected=""[^>]*>Use global default<\/option>/);
    expect(html).not.toContain(COPY.loadFailed);
  });

  it('disables loading and failed-load choices and makes only failure explicitly retryable', () => {
    const loading = render({ status: 'loading', target: project });
    expect(loading).toContain(project.name);
    expect(loading).toContain(COPY.loading);
    expect(select(loading)).toMatch(/\sdisabled(?:=|\s|>)/);
    expect(loading).not.toContain('>Retry<');
    const failed = render({ status: 'error', target: project, message: 'Read denied' });
    expect(select(failed)).toMatch(/\sdisabled(?:=|\s|>)/);
    expect(failed).toContain(COPY.loadFailed);
    expect(failed).toContain('Read denied');
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('>Retry<');
  });

  it('displays pending separately from confirmed and announces saving without success', () => {
    const html = render(ready({ pendingName: null, feedback: { status: 'saving' } }));
    expect(select(html)).toMatch(/\sdisabled(?:=|\s|>)/);
    expect(html).toMatch(/<option[^>]*selected=""[^>]*>Use global default<\/option>/);
    expect(html).toContain('Current saved default: Codex');
    expect(html).toContain(COPY.saving);
    expect(html).toContain('role="status"');
    expect(html).not.toContain(COPY.saved);
  });

  it('announces success only after confirmation and reports actionable save failure', () => {
    const saved = render(ready({ feedback: { status: 'saved' } }));
    expect(saved).toContain(COPY.saved);
    expect(saved).toContain('role="status"');
    const failed = render(ready({ feedback: { status: 'error', message: 'Write denied' } }));
    expect(failed).toContain(COPY.saveFailed);
    expect(failed).toContain('Write denied');
    expect(failed).toContain('Choose again to retry.');
    expect(failed).toContain('role="alert"');
    expect(failed).not.toContain(COPY.saved);
    expect(select(failed)).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(failed).toMatch(/<option[^>]*selected=""[^>]*>Codex<\/option>/);
  });

  it.each(['first', 'subsequent'] as const)('explains %s legacy replacement before the select and permits applying valid current choice', (variant) => {
    const legacy = { ...project, config: { launchCmd: { [variant]: { argv: ['legacy'], env: {} } } } };
    const html = render(ready({ project: legacy }));
    expect(html).toContain(COPY.customCommandsNotice);
    expect(html.indexOf(COPY.customCommandsNotice)).toBeLessThan(html.indexOf('<select'));
    expect(html).toContain(COPY.replaceCustomCommands);
    const global = render(ready({ project: legacy, confirmedName: null, pendingName: null }));
    expect(global).toContain(COPY.replaceCustomCommands);
    const saving = render(ready({ project: legacy, feedback: { status: 'saving' } }));
    expect(saving).toMatch(/<button[^>]*disabled=""[^>]*>Replace custom commands with this default<\/button>/);
    expect(render(ready())).not.toContain(COPY.replaceCustomCommands);
  });

  it('preserves exact missing name as disabled selected option and offers truthful fallback explanation', () => {
    const html = render(ready({ confirmedName: 'Gone & exact', pendingName: 'Gone & exact' }));
    expect(html).toMatch(/<option[^>]*disabled=""[^>]*selected=""[^>]*>Gone &amp; exact \(unavailable\)<\/option>/);
    expect(html).toContain('saved profile');
    expect(html).toContain(COPY.missingProfileFallback);
    expect(select(html)).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(html).not.toContain(COPY.replaceCustomCommands);
  });

  it('does not claim global fallback controls legacy launches for missing saved profile', () => {
    const legacy = { ...project, config: { launchCmd: { first: { argv: ['legacy'], env: {} } } } };
    const html = render(ready({ project: legacy, confirmedName: 'Gone', pendingName: 'Gone' }));
    expect(html).toContain(COPY.customCommandsNotice);
    expect(html).not.toContain(COPY.missingProfileFallback);
    expect(html).not.toContain(COPY.replaceCustomCommands);
  });

  it('renders profile and error text safely without exposing commands or environment', () => {
    const html = render(ready({ profiles: [{ name: '<Agent>', argv: ['secret-command'], env: { TOKEN: 'secret-token' }, scope: 'project' }],
      confirmedName: '<Agent>', pendingName: '<Agent>', feedback: { status: 'error', message: '<failure>' } }));
    expect(html).toContain('&lt;Agent&gt;');
    expect(html).toContain('&lt;failure&gt;');
    expect(html).not.toContain('<Agent>');
    expect(html).not.toContain('secret-command');
    expect(html).not.toContain('secret-token');
  });
});

describe('built-in Terminal choice', () => {
  it('offers Terminal after the global default and shows it selected without an unavailable warning', () => {
    const html = render(ready({ confirmedName: 'Terminal', pendingName: 'Terminal' }));
    expect(html).toContain(`<option value="profile:Terminal" selected="">${COPY.terminalAgent}</option>`);
    expect(html).not.toContain(COPY.unavailableProfile('Terminal'));
  });

  it('is not duplicated when a CLI profile is already named Terminal', () => {
    const base = ready();
    if (base.status !== 'ready') throw new Error('ready snapshot expected');
    const html = render({ ...base, profiles: [...base.profiles, { name: 'Terminal', argv: ['fish'], scope: 'project' }] });
    expect(html).not.toContain(COPY.terminalAgent);
    expect(html.match(/value="profile:Terminal"/g)).toHaveLength(1);
  });
});
