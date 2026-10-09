import { describe, it, expect, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  EnvEditor,
  EnvRowEditor,
  discardEnvDraft,
  maskIfStoredRekeyed,
  envErrorDetail,
  rowActions,
  saveEnvRows,
  type EnvRowActions,
  type EnvSource,
} from '@renderer/components/env/EnvEditor';
import { EnvValueField } from '@renderer/components/env/EnvValueField';
import { createRevealTimers, rowRevealKey } from '@renderer/env-reveal';
import type { EnvDraft, EnvDrafts } from '@renderer/hooks/useEnvDrafts';
import { toastBus, type Toast } from '@renderer/hooks/useToasts';
import type { RevealState } from '@renderer/hooks/useRevealState';
import { rowsFromEnv, type EnvRow } from '@renderer/project-env-rows';
import { APP_ENV_COPY, APP_ENV_TESTIDS, ENV_COPY, ENV_TESTIDS } from '@renderer/project-env-copy';

type Props = Record<string, unknown> & { children?: ReactNode };
type EditorProps = Parameters<typeof EnvEditor>[0];
type RowProps = Parameters<typeof EnvRowEditor>[0];
type FieldProps = Parameters<typeof EnvValueField>[0];

const STORED = { API_URL: 'https://prod.example', GITHUB_TOKEN: 'ghp_SECRETVALUE' };
const masked: RevealState = {
  isRevealed: () => false,
  toggle: vi.fn(),
  hide: vi.fn(),
  clearAll: vi.fn(),
};

function fakeDrafts(draft?: EnvDraft): EnvDrafts {
  return { get: () => draft, set: vi.fn(), clear: vi.fn(), isDirty: () => false };
}

function source(over: Partial<EnvSource> = {}): EnvSource {
  return {
    draftKey: 7,
    drafts: fakeDrafts(),
    stored: STORED,
    load: 'ready',
    persist: vi.fn(async () => undefined),
    ...over,
  };
}

function render(over: Partial<EditorProps> = {}): string {
  return renderToStaticMarkup(
    <EnvEditor
      source={source()}
      scope="project"
      subtitle="my-project"
      reveal={masked}
      onCopy={vi.fn()}
      {...over}
    />,
  );
}

function withDraft(rows: EnvRow[], over: Partial<EditorProps> = {}): string {
  return render({ source: source({ drafts: fakeDrafts({ stored: STORED, rows }) }), ...over });
}

function rowsOf(html: string): string[] {
  return html.split(`data-testid="${ENV_TESTIDS.row}"`).slice(1);
}

function tag(html: string, tagName: string, testId: string): string {
  const match = new RegExp(`<${tagName}\\b[^>]*data-testid="${testId}"[^>]*>`).exec(html);
  if (!match) throw new Error(`no <${tagName}> with data-testid=${testId}`);
  return match[0];
}

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

describe('EnvEditor rows', () => {
  it('renders the stored rows in order when there is no draft', () => {
    const rows = rowsOf(render());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('value="API_URL"');
    expect(rows[1]).toContain('value="GITHUB_TOKEN"');
  });

  it('renders the draft rows over the stored ones', () => {
    const rows = rowsOf(withDraft([{ key: 4, name: 'ONLY', value: 'draft-value' }]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('value="ONLY"');
  });

  it('orders each row name, value, reveal, copy, remove (AC33)', () => {
    const rows = rowsOf(render());
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const at = (id: string) => row.indexOf(`data-testid="${id}"`);
      const order = [
        ENV_TESTIDS.name,
        ENV_TESTIDS.value,
        ENV_TESTIDS.reveal,
        ENV_TESTIDS.copy,
        ENV_TESTIDS.remove,
      ].map(at);
      expect(order.every((i) => i > -1)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
  });

  it('masks every value, stored, drafted or newly added, and never a name (AC20)', () => {
    for (const html of [
      render(),
      withDraft([
        { key: 0, name: 'A', value: 'x' },
        { key: 1, name: '', value: '' },
      ]),
    ]) {
      const rows = rowsOf(html);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(tag(row, 'input', ENV_TESTIDS.value)).toContain('type="password"');
        expect(tag(row, 'input', ENV_TESTIDS.name)).not.toContain('type="password"');
      }
    }
  });

  it('reveals only the rows the reveal state names, by row:<key> (AC21)', () => {
    const html = withDraft(
      [
        { key: 3, name: 'A', value: 'a' },
        { key: 8, name: 'B', value: 'b' },
      ],
      {
        reveal: {
          isRevealed: (k) => k === 'row:8',
          toggle: vi.fn(),
          hide: vi.fn(),
          clearAll: vi.fn(),
        },
      },
    );
    const [first, second] = rowsOf(html);
    expect(tag(first ?? '', 'input', ENV_TESTIDS.value)).toContain('type="password"');
    expect(tag(second ?? '', 'input', ENV_TESTIDS.value)).toContain('type="text"');
    expect(second).toContain(`aria-label="${ENV_COPY.hideLabel(2)}"`);
  });

  it('labels each row by position', () => {
    const [, second] = rowsOf(render());
    for (const label of [
      ENV_COPY.nameLabel(2),
      ENV_COPY.valueLabel(2),
      ENV_COPY.revealLabel(2),
      ENV_COPY.copyLabel(2),
      ENV_COPY.removeLabel(2),
    ]) {
      expect(second).toContain(`aria-label="${label}"`);
    }
  });

  it('shows values only inside value attributes', () => {
    const html = render();
    for (const value of Object.values(STORED)) {
      expect(html).toContain(`value="${value}"`);
      expect(html.replace(`value="${value}"`, '')).not.toContain(value);
    }
  });
});

describe('EnvEditor validation (AC2, AC27)', () => {
  const NUL_VALUE = 'tok\u0000en-SECRET';

  it('shows the NUL reason while masked, tied to the value input, without the value', () => {
    const [row] = rowsOf(withDraft([{ key: 0, name: 'A', value: NUL_VALUE }]));
    const value = tag(row ?? '', 'input', ENV_TESTIDS.value);
    expect(value).toContain('type="password"');
    expect(value).toContain('aria-invalid="true"');
    const reason =
      /<p[^>]*id="([^"]+)"[^>]*data-testid="project-env-reason"[^>]*>([^<]*)<\/p>/.exec(row ?? '');
    expect(reason?.[2]).toBe(ENV_COPY.reason.nul);
    expect(value).toContain(`aria-describedby="${reason?.[1]}"`);
    expect(tag(row ?? '', 'input', ENV_TESTIDS.name)).not.toContain('aria-invalid');
    expect(reason?.[2]).not.toContain('SECRET');
  });

  it('marks the name, not the value, for a name problem', () => {
    const [row] = rowsOf(withDraft([{ key: 0, name: '1BAD', value: 'v' }]));
    expect(tag(row ?? '', 'input', ENV_TESTIDS.name)).toContain('aria-invalid="true"');
    expect(tag(row ?? '', 'input', ENV_TESTIDS.value)).not.toContain('aria-invalid');
    expect(textOf(row ?? '')).toContain(ENV_COPY.reason.invalid);
  });

  it('disables Save for an invalid draft, enables it for a valid one', () => {
    const bad = withDraft([{ key: 0, name: 'METAIDE_X', value: 'v' }]);
    expect(tag(bad, 'button', ENV_TESTIDS.save)).toContain('disabled=""');
    expect(tag(render(), 'button', ENV_TESTIDS.save)).not.toContain('disabled=""');
  });

  it('disables Save and Add until the stored map has loaded', () => {
    for (const load of ['loading', 'failed'] as const) {
      const html = render({ source: source({ load }) });
      expect(tag(html, 'button', ENV_TESTIDS.save)).toContain('disabled=""');
      expect(tag(html, 'button', ENV_TESTIDS.add)).toContain('disabled=""');
    }
  });

  it('gives each editor instance its own reason ids', () => {
    const rows = [{ key: 0, name: '1BAD', value: '' }];
    const drafts = fakeDrafts({ stored: {}, rows });
    const html = renderToStaticMarkup(
      <>
        <EnvEditor
          source={source({ drafts })}
          scope="project"
          subtitle="p"
          reveal={masked}
          onCopy={vi.fn()}
        />
        <EnvEditor
          source={source({ drafts })}
          scope="app"
          subtitle="a"
          reveal={masked}
          onCopy={vi.fn()}
        />
      </>,
    );
    const ids = [...html.matchAll(/<p[^>]*id="([^"]+)"[^>]*data-testid="project-env-reason"/g)].map(
      (m) => m[1],
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('EnvEditor chrome (AC1, AC5, AC8, AC17)', () => {
  it.each(['project', 'app'] as const)('shows all four notices and the hint (%s)', (scope) => {
    const text = textOf(render({ scope }));
    for (const notice of [
      ENV_COPY.noticeNewShells,
      ENV_COPY.noticeUnencrypted,
      ENV_COPY.noticeLaunchArgs,
      ENV_COPY.tokensHint,
    ]) {
      expect(text).toContain(notice);
    }
  });

  it('titles the project editor and labels its panel', () => {
    const html = render();
    expect(html).toMatch(new RegExp(`^<section[^>]*data-testid="${ENV_TESTIDS.panel}"`));
    const id = /^<section[^>]*aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(html).toMatch(new RegExp(`<h2[^>]*id="${id}"[^>]*>${ENV_COPY.panelTitle}</h2>`));
    expect(textOf(html)).toContain('my-project');
  });

  it('titles the app editor and labels its panel', () => {
    const html = render({ scope: 'app', subtitle: APP_ENV_COPY.panelSubtitle });
    expect(html).toMatch(new RegExp(`^<section[^>]*data-testid="${APP_ENV_TESTIDS.panel}"`));
    const id = /^<section[^>]*aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(html).toMatch(new RegExp(`<h2[^>]*id="${id}"[^>]*>${APP_ENV_COPY.panelTitle}</h2>`));
    expect(textOf(html)).toContain(APP_ENV_COPY.panelSubtitle);
    expect(html).not.toContain(`data-testid="${ENV_TESTIDS.panel}"`);
  });

  it.each([
    ['project', ENV_TESTIDS.empty, ENV_COPY.emptyState],
    ['app', APP_ENV_TESTIDS.empty, APP_ENV_COPY.emptyState],
  ] as const)(
    'shows the %s empty state and an enabled Add when ready with no rows',
    (scope, testId, text) => {
      const html = render({ scope, source: source({ stored: {} }) });
      expect(html).toMatch(new RegExp(`data-testid="${testId}"[^>]*>${text}<`));
      expect(tag(html, 'button', ENV_TESTIDS.add)).not.toContain('disabled=""');
      expect(textOf(html)).toContain(ENV_COPY.addRow);
    },
  );

  it('shows no empty state while loading or when there are rows', () => {
    expect(render({ source: source({ stored: {}, load: 'loading' }) })).not.toContain(
      ENV_TESTIDS.empty,
    );
    expect(render()).not.toContain(ENV_TESTIDS.empty);
  });

  it('renders rows, then Add, then Discard and Save, then the children (D14)', () => {
    const html = render({ children: <div data-testid="after-actions" /> });
    const at = (id: string) => html.indexOf(`data-testid="${id}"`);
    const order = [
      ENV_TESTIDS.row,
      ENV_TESTIDS.add,
      ENV_TESTIDS.discard,
      ENV_TESTIDS.save,
      'after-actions',
    ].map(at);
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.lastIndexOf(`data-testid="${ENV_TESTIDS.row}"`)).toBeLessThan(at(ENV_TESTIDS.add));
  });
});

function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}

describe('EnvRowEditor actions (AC26, AC28, AC29)', () => {
  function rowProps(over: Partial<RowProps> = {}): RowProps & { actions: EnvRowActions } {
    return {
      row: { key: 5, name: 'TOKEN', value: 'raw ${env.HOME} value' },
      n: 1,
      problem: null,
      reasonId: 'reason-5',
      actions: {
        reveal: { isRevealed: () => false, toggle: vi.fn(), hide: vi.fn(), clearAll: vi.fn() },
        onCopy: vi.fn(),
        onChange: vi.fn(),
        onRemove: vi.fn(),
      },
      ...over,
    };
  }

  function field(p: RowProps): FieldProps {
    const el = elements(EnvRowEditor(p)).find((e) => e.type === EnvValueField);
    if (!el) throw new Error('no EnvValueField');
    return el.props as unknown as FieldProps;
  }

  it('copies the raw draft value without toggling the reveal', () => {
    const p = rowProps();
    field(p).onCopy();
    expect(p.actions.onCopy).toHaveBeenCalledWith('raw ${env.HOME} value');
    expect(p.actions.reveal.toggle).not.toHaveBeenCalled();
  });

  it('toggles the reveal under row:<key>', () => {
    const p = rowProps();
    field(p).onToggle();
    expect(p.actions.reveal.toggle).toHaveBeenCalledWith('row:5');
  });

  it('patches the value on edit without touching the reveal', () => {
    const p = rowProps();
    field(p).onChange?.('typed');
    expect(p.actions.onChange).toHaveBeenCalledWith(5, { value: 'typed' });
    expect(p.actions.reveal.toggle).not.toHaveBeenCalled();
  });

  it('patches the name on edit and removes by key', () => {
    const p = rowProps();
    const els = elements(EnvRowEditor(p));
    const name = els.find((e) => e.props['data-testid'] === ENV_TESTIDS.name);
    (name?.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: 'N' },
    });
    expect(p.actions.onChange).toHaveBeenCalledWith(5, { name: 'N' });
    const remove = els.find((e) => e.props['data-testid'] === ENV_TESTIDS.remove);
    (remove?.props.onClick as () => void)();
    expect(p.actions.onRemove).toHaveBeenCalledWith(5);
  });
});

describe('saveEnvRows', () => {
  const ROWS: EnvRow[] = [
    { key: 0, name: 'A', value: 'secret-a' },
    { key: 1, name: '', value: '' },
  ];

  function reveal(): RevealState {
    return { isRevealed: () => true, toggle: vi.fn(), hide: vi.fn(), clearAll: vi.fn() };
  }

  function lastToast(): Toast | undefined {
    let latest: Toast[] = [];
    toastBus.subscribe((items) => {
      latest = items;
    })();
    return latest[0];
  }

  it('persists the rows map, drops the draft and masks every value after a save', async () => {
    const src = source();
    const state = reveal();
    await saveEnvRows(ROWS, src, state);
    expect(src.persist).toHaveBeenCalledWith({ A: 'secret-a' });
    expect(src.drafts.clear).toHaveBeenCalledWith(7);
    expect(state.clearAll).toHaveBeenCalledTimes(1);
  });

  it('masks only after the save succeeds', async () => {
    const order: string[] = [];
    const state: RevealState = { ...reveal(), clearAll: () => order.push('clear') };
    const src = source({
      persist: async () => {
        order.push('persist');
      },
    });
    await saveEnvRows(ROWS, src, state);
    expect(order).toEqual(['persist', 'clear']);
  });

  it('keeps the draft and the reveal state when the save fails, and toasts the key-only reason', async () => {
    const state = reveal();
    const src = source({
      persist: vi.fn(async () => {
        throw new Error('Invalid app environment variable "A": reserved');
      }),
    });
    await saveEnvRows(ROWS, src, state);
    expect(src.drafts.clear).not.toHaveBeenCalled();
    expect(state.clearAll).not.toHaveBeenCalled();
    const t = lastToast();
    expect(t?.kind).toBe('error');
    expect(t?.title).toBe(ENV_COPY.saveFailed);
    expect(t?.detail).toBe('Invalid app environment variable "A": reserved');
    expect(`${t?.title} ${t?.detail}`).not.toContain('secret-a');
  });
});

describe('envErrorDetail', () => {
  it('drops the leading "Error: " and keeps the rest', () => {
    expect(envErrorDetail(new Error('bad "KEY"'))).toBe('bad "KEY"');
    expect(envErrorDetail('plain')).toBe('plain');
  });
});

describe('a new row is never shown revealed (AC20, G3)', () => {
  function liveReveal(): RevealState {
    return createRevealTimers({ onChange: () => undefined });
  }

  function editorRows(start: EnvRow[], reveal: RevealState) {
    let rows = start;
    const set = (next: EnvRow[]) => {
      rows = next;
    };
    return {
      get rows() {
        return rows;
      },
      set,
      act: () => rowActions(rows, set, vi.fn(), reveal),
    };
  }

  function revealedOnScreen(row: EnvRow, reveal: RevealState): boolean {
    const actions: EnvRowActions = {
      reveal,
      onCopy: vi.fn(),
      onChange: vi.fn(),
      onRemove: vi.fn(),
    };
    const el = elements(EnvRowEditor({ row, n: 1, problem: null, reasonId: 'r', actions })).find(
      (e) => e.type === EnvValueField,
    );
    return (el?.props as unknown as FieldProps).revealed;
  }

  function toggleOnScreen(row: EnvRow, reveal: RevealState) {
    const actions: EnvRowActions = {
      reveal,
      onCopy: vi.fn(),
      onChange: vi.fn(),
      onRemove: vi.fn(),
    };
    const el = elements(EnvRowEditor({ row, n: 1, problem: null, reasonId: 'r', actions })).find(
      (e) => e.type === EnvValueField,
    );
    (el?.props as unknown as FieldProps).onToggle();
  }

  it('remove a revealed row, then Add: the new blank row is masked', () => {
    const reveal = liveReveal();
    const ed = editorRows(rowsFromEnv({ A: 'a', B: 'secret-b' }), reveal);
    const rowB = ed.rows[1]!;
    toggleOnScreen(rowB, reveal);
    expect(revealedOnScreen(rowB, reveal)).toBe(true);
    ed.act().onRemove(rowB.key);
    ed.act().onAdd();
    const added = ed.rows.at(-1)!;
    expect(added).toMatchObject({ name: '', value: '' });
    expect(revealedOnScreen(added, reveal)).toBe(false);
  });

  it('removing a revealed row leaves the other revealed rows revealed', () => {
    const reveal = liveReveal();
    const ed = editorRows(rowsFromEnv({ A: 'a', B: 'b' }), reveal);
    const [rowA, rowB] = ed.rows as [EnvRow, EnvRow];
    toggleOnScreen(rowA, reveal);
    toggleOnScreen(rowB, reveal);
    ed.act().onRemove(rowB.key);
    expect(revealedOnScreen(rowA, reveal)).toBe(true);
  });

  it('add, reveal, Discard, then Add: the new blank row is masked', () => {
    const reveal = liveReveal();
    const drafts = fakeDrafts();
    const src = source({ drafts, stored: {} });
    const ed = editorRows(rowsFromEnv(src.stored), reveal);
    ed.act().onAdd();
    toggleOnScreen(ed.rows[0]!, reveal);
    expect(revealedOnScreen(ed.rows[0]!, reveal)).toBe(true);
    discardEnvDraft(src, reveal);
    expect(drafts.clear).toHaveBeenCalledWith(7);
    ed.set(rowsFromEnv(src.stored));
    ed.act().onAdd();
    expect(revealedOnScreen(ed.rows.at(-1)!, reveal)).toBe(false);
  });

  it('Discard masks the restored stored rows too', () => {
    const reveal = liveReveal();
    const src = source();
    const stored = rowsFromEnv(src.stored);
    toggleOnScreen(stored[1]!, reveal);
    discardEnvDraft(src, reveal);
    expect(revealedOnScreen(stored[1]!, reveal)).toBe(false);
  });
});

describe('maskIfStoredRekeyed: a stored map that changes under the shown rows masks them (AC20, G3)', () => {
  const BEFORE = { A: 'a', B: 'secret-b' };

  function revealedRow1(): RevealState {
    const reveal = createRevealTimers({ onChange: () => undefined });
    reveal.toggle(rowRevealKey(1));
    return reveal;
  }

  it('re-ordered stored map with no draft: the previously revealed row is masked', () => {
    const reveal = revealedRow1();
    const after = { B: 'secret-b', A: 'a' };
    maskIfStoredRekeyed(BEFORE, after, false, reveal);
    expect(rowsFromEnv(after)[1]?.name).toBe('A');
    expect(reveal.isRevealed(rowRevealKey(1))).toBe(false);
  });

  it('an added, removed or changed entry with no draft masks too', () => {
    const afters: Record<string, string>[] = [
      { ...BEFORE, C: 'c' },
      { A: 'a' },
      { A: 'a', B: 'other' },
    ];
    for (const after of afters) {
      const reveal = revealedRow1();
      maskIfStoredRekeyed(BEFORE, after, false, reveal);
      expect(reveal.isRevealed(rowRevealKey(1))).toBe(false);
    }
  });

  it('the same entries in a new object (a re-render or re-read) keep the reveal', () => {
    const reveal = revealedRow1();
    maskIfStoredRekeyed(BEFORE, { ...BEFORE }, false, reveal);
    maskIfStoredRekeyed(BEFORE, BEFORE, false, reveal);
    expect(reveal.isRevealed(rowRevealKey(1))).toBe(true);
  });

  it('keeps the reveal while a draft supplies the rows, since its keys do not move', () => {
    const reveal = revealedRow1();
    maskIfStoredRekeyed(BEFORE, { B: 'secret-b', A: 'a' }, true, reveal);
    expect(reveal.isRevealed(rowRevealKey(1))).toBe(true);
  });
});
