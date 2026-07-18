import { useCallback, useEffect, useState } from 'react';
import type { LaunchCmd, Root, SettingsMap } from '@shared/types';
import { parseArgv } from '@shared/parse-argv';
import { api } from '@renderer/api';
import { useTheme, type ThemeMode } from '@renderer/hooks/useTheme';

type Section = 'general' | 'roots' | 'launch' | 'metaproject';

export function Settings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [section, setSection] = useState<Section>('general');
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      data-testid="settings-modal"
    >
      <div
        className="relative bg-[--panel-strong] w-[760px] max-w-[92vw] h-[600px] max-h-[92vh] rounded-xl shadow-2xl border border-[--border] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="drag h-11 flex items-center justify-between border-b border-[--border] pl-4 pr-2 shrink-0 bg-[--panel]/60">
          <span className="text-sm font-semibold">Settings</span>
          <button
            onClick={onClose}
            className="no-drag text-[--text-muted] hover:text-[--text] w-8 h-8 flex items-center justify-center rounded-md hover:bg-[--panel-strong]"
            title="Close (Esc)"
            data-testid="settings-close"
            aria-label="Close settings"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Body: nav + panel */}
        <div className="flex-1 min-h-0 flex">
          <nav className="w-48 shrink-0 border-r border-[--border] bg-[--panel]/40 p-3 flex flex-col gap-1">
            <SectionButton active={section === 'general'} onClick={() => setSection('general')}>General</SectionButton>
            <SectionButton active={section === 'roots'}   onClick={() => setSection('roots')}>Root directories</SectionButton>
            <SectionButton active={section === 'launch'}  onClick={() => setSection('launch')}>Launch commands</SectionButton>
            <SectionButton active={section === 'metaproject'} onClick={() => setSection('metaproject')}>Metaproject</SectionButton>
            <div className="mt-auto text-[10px] text-[--text-muted] px-2 pt-3">
              MetaLogix IDE · Phase 1
            </div>
          </nav>
          <div className="flex-1 min-h-0 overflow-y-auto p-6">
            {section === 'general' && <GeneralPanel />}
            {section === 'roots'   && <RootsPanel />}
            {section === 'launch'  && <LaunchPanel />}
            {section === 'metaproject' && <MetaprojectPanel />}
          </div>
        </div>

        {/* Footer */}
        <div className="h-12 flex items-center justify-end gap-2 border-t border-[--border] px-4 bg-[--panel]/60">
          <button
            onClick={onClose}
            className="text-sm px-4 py-1.5 bg-[--accent] hover:brightness-110 text-white rounded-md"
            data-testid="settings-done"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function SectionButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-2 py-1.5 rounded-md text-sm ${
        active ? 'bg-[color:var(--accent)] text-white' : 'hover:bg-[--panel-strong] text-[--text]'
      }`}
    >
      {children}
    </button>
  );
}

/* ─────────────────────────────── General ─────────────────────────────── */

function GeneralPanel() {
  const { mode, effective, setMode } = useTheme();
  const [cap, setCap] = useState<number | null>(null);
  const [scanDepth, setScanDepth] = useState<number | null>(null);
  const [maxWatched, setMaxWatched] = useState<number | null>(null);

  const load = useCallback(async () => {
    const [c, d, w] = await Promise.all([
      api.invoke('settings:get', { key: 'keep_alive_cap' }),
      api.invoke('settings:get', { key: 'scan_depth' }),
      api.invoke('settings:get', { key: 'max_watched_paths' }),
    ]);
    setCap(c.value as number);
    setScanDepth(d.value as number);
    setMaxWatched(w.value as number);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save<K extends keyof SettingsMap>(key: K, value: SettingsMap[K]) {
    await api.invoke('settings:set', { key, value });
  }

  return (
    <div className="space-y-6">
      <Header title="General" subtitle="Appearance and workspace defaults" />

      <Field label="Appearance" hint="Switch how the app renders. System follows your OS.">
        <div className="flex gap-2">
          {(['system', 'light', 'dark'] as ThemeMode[]).map((t) => (
            <button
              key={t}
              onClick={() => setMode(t)}
              className={`px-3 py-1.5 rounded-md text-sm border ${
                mode === t
                  ? 'bg-[--accent] text-white border-transparent'
                  : 'bg-[--panel] border-[--border] hover:bg-[--panel-strong]'
              }`}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
              {t === 'system' && <span className="ml-1 text-xs opacity-70">({effective})</span>}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Keep-alive cap" hint="How many project shells can stay running simultaneously. LRU evicts the oldest.">
        <NumberInput value={cap} min={1} max={20} onChange={(v) => { setCap(v); void save('keep_alive_cap', v); }} />
      </Field>

      <Field label="Root scan depth" hint="How many folder levels below a root count as projects. Raise for monorepos.">
        <NumberInput value={scanDepth} min={1} max={4} onChange={(v) => { setScanDepth(v); void save('scan_depth', v); }} />
      </Field>

      <Field label="Max watched paths" hint="Filesystem watcher cap across all roots. Prevents runaway CPU on huge trees.">
        <NumberInput value={maxWatched} min={50} max={5000} step={50} onChange={(v) => { setMaxWatched(v); void save('max_watched_paths', v); }} />
      </Field>
    </div>
  );
}

/* ──────────────────────────────── Roots ──────────────────────────────── */

function RootsPanel() {
  const [roots, setRoots] = useState<Root[]>([]);

  const refresh = useCallback(async () => {
    const { roots } = await api.invoke('roots:list', undefined as never);
    setRoots(roots);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function add() {
    const picked = await api.invoke('dialogs:pick-directory', undefined as never);
    const path = picked.path ?? window.prompt('Root directory path (absolute):');
    if (!path) return;
    await api.invoke('roots:add', { path });
    await refresh();
  }
  async function remove(id: number) {
    if (!window.confirm('Remove this root? Projects underneath are un-registered.')) return;
    await api.invoke('roots:remove', { id });
    await refresh();
  }
  async function rescan(id: number) {
    await api.invoke('roots:rescan', { id });
  }

  return (
    <div className="space-y-4">
      <Header title="Root directories" subtitle="Folders scanned for projects. Add each parent folder where your projects live." />
      <button
        onClick={add}
        className="w-full text-sm font-medium bg-[--accent] hover:brightness-110 text-white rounded-md py-2"
      >
        + Add root
      </button>
      <ul className="space-y-2">
        {roots.length === 0 && <li className="text-sm text-[--text-muted]">No roots yet.</li>}
        {roots.map((r) => (
          <li key={r.id} className="flex items-center gap-2 border border-[--border] rounded-md px-3 py-2 bg-[--panel]/60">
            <span className="flex-1 text-sm truncate font-mono" title={r.path}>{r.path}</span>
            <button onClick={() => rescan(r.id)} className="text-xs text-[--text-muted] hover:text-[--text] px-2 py-1 rounded hover:bg-[--panel-strong]">Rescan</button>
            <button onClick={() => remove(r.id)} className="text-xs text-[--danger] hover:brightness-110 px-2 py-1 rounded hover:bg-[--panel-strong]">Remove</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ─────────────────────────── Launch commands ─────────────────────────── */

function LaunchPanel() {
  const [first, setFirst]           = useState<LaunchCmd | null>(null);
  const [subsequent, setSubsequent] = useState<LaunchCmd | null>(null);

  const load = useCallback(async () => {
    const [f, s] = await Promise.all([
      api.invoke('settings:get', { key: 'default_launch_cmd.first' }),
      api.invoke('settings:get', { key: 'default_launch_cmd.subsequent' }),
    ]);
    setFirst(f.value as LaunchCmd);
    setSubsequent(s.value as LaunchCmd);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function saveFirst(value: LaunchCmd) {
    setFirst(value);
    await api.invoke('settings:set', { key: 'default_launch_cmd.first', value });
  }
  async function saveSubsequent(value: LaunchCmd) {
    setSubsequent(value);
    await api.invoke('settings:set', { key: 'default_launch_cmd.subsequent', value });
  }

  return (
    <div className="space-y-6">
      <Header
        title="Launch commands"
        subtitle="What runs when you open a project. First launch runs 'first'; subsequent launches use 'subsequent' (typically adds --continue)."
      />
      {first && <LaunchEditor label="First launch" value={first} onChange={saveFirst} />}
      {subsequent && <LaunchEditor label="Subsequent launches" value={subsequent} onChange={saveSubsequent} />}
      <div className="text-xs text-[--text-muted] leading-relaxed">
        Tokens supported: <code>${'{HOME}'}</code>, <code>${'{PROJECT_PATH}'}</code>, <code>${'{PROJECT_NAME}'}</code>, <code>${'{env.NAME}'}</code>.
        Interpolation is per-argv-element, so tokens cannot introduce new arguments.
      </div>
    </div>
  );
}

function LaunchEditor({ label, value, onChange }: { label: string; value: LaunchCmd; onChange: (v: LaunchCmd) => void }) {
  const [argvText, setArgvText] = useState(value.argv.join(' '));
  useEffect(() => { setArgvText(value.argv.join(' ')); }, [value]);

  function commit() {
    // Simple shell-like split preserving quoted strings.
    const argv = parseArgv(argvText);
    if (argv.length === 0) return;
    onChange({ ...value, argv });
  }

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-[--text-muted] uppercase tracking-wider">{label}</div>
      <input
        value={argvText}
        onChange={(e) => setArgvText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); } }}
        className="w-full font-mono text-sm bg-[--panel]/70 border border-[--border] rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[--accent]/60"
        placeholder='e.g. claude --dangerously-skip-permissions'
      />
      <div className="text-[11px] text-[--text-muted]">argv: <span className="font-mono">{JSON.stringify(value.argv)}</span></div>
    </div>
  );
}

/* ─────────────────────────── Metaproject ─────────────────────────── */

function MetaprojectPanel() {
  const [url, setUrl] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const { value } = await api.invoke('settings:get', { key: 'metaproject_base_url' });
        setUrl(typeof value === 'string' ? value : '');
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  async function save() {
    const normalized = url.trim().replace(/\/$/, '');
    await api.invoke('settings:set', { key: 'metaproject_base_url', value: normalized });
    setUrl(normalized);
  }

  return (
    <div className="space-y-6">
      <Header
        title="Metaproject"
        subtitle="Optional. When set, projects with a .metaproject.yaml linking a project_id get a Board button that opens the board in your browser."
      />
      <Field label="Base URL" hint="e.g. https://metaproject.internal — used to build /board/{project_id} links.">
        <div className="flex gap-2">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => { if (e.key === 'Enter') { void save(); (e.target as HTMLInputElement).blur(); } }}
            placeholder="https://metaproject.internal"
            className="flex-1 bg-[--panel-strong] text-[--text] border border-[--border] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[--accent]/60"
            data-testid="metaproject-base-url"
          />
        </div>
      </Field>
      <div className="text-xs text-[--text-muted] leading-relaxed">
        Add <code className="font-mono">project_id: PROJ-42</code> to a project&rsquo;s <code className="font-mono">.metaproject.yaml</code>
        &nbsp;and the sidebar will show a Board button linked to it. Live chat and ticket sync land in a later phase.
        {!loaded && <div className="mt-2 opacity-60">Loading…</div>}
      </div>
    </div>
  );
}

/* ────────────────────────────── primitives ───────────────────────────── */

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="space-y-1">
      <div className="text-lg font-semibold">{title}</div>
      <div className="text-sm text-[--text-muted]">{subtitle}</div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{label}</div>
      {hint && <div className="text-xs text-[--text-muted]">{hint}</div>}
      {children}
    </div>
  );
}

function NumberInput({ value, min, max, step = 1, onChange }: { value: number | null; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      value={value ?? ''}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
      }}
      className="w-32 bg-[--panel-strong] text-[--text] border border-[--border] rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-[--accent]/60"
    />
  );
}

