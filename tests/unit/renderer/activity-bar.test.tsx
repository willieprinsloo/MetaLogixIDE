/**
 * ActivityBar chrome contract (AC10-AC14): bar/button/icon geometry, badge
 * placement and shape, soft-tint tones, 99+ cap, hidden-when-empty.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityBar, ABButton } from '@renderer/components/ActivityBar';

const noop = () => {};
function render(props: { chatUnread?: number; gitDirty?: number; taskCount?: number; active?: 'projects' | 'chat' | 'git' | 'tasks' | 'fleet' } = {}) {
  return renderToStaticMarkup(
    <ActivityBar active={props.active ?? 'projects'} onSelect={noop} onToggleSidebar={noop} sidebarOpen
      chatUnread={props.chatUnread} gitDirty={props.gitDirty} taskCount={props.taskCount} />,
  );
}
const classesOf = (tag: string) => (/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(/\s+/);
const buttons = (html: string) => html.match(/<button\b[^>]*>/g) ?? [];
const svgs = (html: string) => html.match(/<svg\b[^>]*>/g) ?? [];
const navTag = (html: string) => /<nav\b[^>]*>/.exec(html)?.[0] ?? '';
/** Badge span (tag + text) inside the button carrying `id`, or null. */
function badgeOf(html: string, id: string): { classes: string[]; text: string } | null {
  const btn = new RegExp(`<button\\b[^>]*data-testid="${id}"[^>]*>([\\s\\S]*?)</button>`).exec(html);
  const m = btn?.[1] && /(<span\b[^>]*data-tone[^>]*>)([^<]*)<\/span>/.exec(btn[1]);
  return m ? { classes: classesOf(m[1] ?? ""), text: m[2] ?? "" } : null;
}

describe('ActivityBar geometry (AC10)', () => {
  it('bar is 56px wide', () => {
    const c = classesOf(navTag(render()));
    expect(c).toContain('w-14');
    expect(c).not.toContain('w-11');
  });
  it('every rail button offers a 44px touch target with 10px radius', () => {
    const bs = buttons(render());
    expect(bs).toHaveLength(6);
    for (const b of bs) {
      expect(classesOf(b)).toEqual(expect.arrayContaining(['w-11', 'h-11', 'rounded-[10px]']));
      expect(classesOf(b)).not.toContain('w-8');
    }
  });
  it('every icon is 16x16', () => {
    const icons = svgs(render());
    expect(icons).toHaveLength(6);
    for (const s of icons) {
      expect(s).toContain('width="16"');
      expect(s).toContain('height="16"');
    }
  });
  it('names the Fleet destination and marks it active without hiding other views', () => {
    const html = render({ active: 'fleet' });
    expect(html).toContain('data-testid="ab-fleet"');
    expect(html).toContain('aria-label="Fleet"');
    expect(html).toMatch(/<button[^>]*aria-label="Fleet"[^>]*aria-current="page"/);
    expect(html).toContain('data-testid="ab-projects"');
    expect(html).toContain('bg-[--accent-soft]');
  });
});

describe('ActivityBar badges (AC11-AC14)', () => {
  const all = { chatUnread: 3, gitDirty: 4, taskCount: 5 };
  it('sits top-right, 16px, 8px radius, 10px semibold', () => {
    const doc = render(all);
    for (const id of ['ab-chat', 'ab-git', 'ab-tasks']) {
      const c = badgeOf(doc, id)?.classes ?? [];
      expect(c).toEqual(expect.arrayContaining(['absolute', 'top-[3px]', 'right-[1px]', 'h-4', 'min-w-4', 'rounded-lg', 'text-[10px]', 'font-semibold']));
      expect(c).not.toContain('-bottom-0.5');
      expect(c).not.toContain('rounded-full');
    }
  });
  it('accent tone uses soft tokens, not solid', () => {
    const doc = render(all);
    for (const id of ['ab-chat', 'ab-git']) {
      const c = badgeOf(doc, id)?.classes ?? [];
      expect(c).toEqual(expect.arrayContaining(['bg-[--accent-soft]', 'text-[--badge-accent-text]']));
      expect(c).not.toContain('bg-[color:var(--accent)]');
    }
  });
  it('orange tone uses soft tokens, not solid', () => {
    const c = badgeOf(render(all), 'ab-tasks')?.classes ?? [];
    expect(c).toEqual(expect.arrayContaining(['bg-[--hue-orange-soft]', 'text-[--hue-orange-soft-text]']));
    expect(c).not.toContain('bg-[--hue-orange]');
    expect(c).not.toContain('text-[--badge-ink]');
  });
  it('caps at 99+', () => {
    const doc = render({ chatUnread: 150 });
    expect(badgeOf(doc, 'ab-chat')?.text).toBe('99+');
    expect(badgeOf(render({ chatUnread: 99 }), 'ab-chat')?.text).toBe('99');
    expect(badgeOf(render({ chatUnread: 100 }), 'ab-chat')?.text).toBe('99+');
  });
  it('renders nothing for 0 or undefined', () => {
    const doc = render({ chatUnread: 0, taskCount: undefined });
    expect(doc).not.toContain('data-tone');
  });
  it('hides the badge on the active view', () => {
    expect(badgeOf(render({ ...all, active: 'git' }), 'ab-git')).toBeNull();
  });
});

describe('ActivityBar footer', () => {
  const withFooter = () => renderToStaticMarkup(
    <ActivityBar active="projects" onSelect={noop} onToggleSidebar={noop} sidebarOpen
      footer={<ABButton label="Settings" onClick={noop} active={false} data-testid="settings-open"><i /></ABButton>} />,
  );
  it('pins footer buttons below a flexible spacer, inside the title-buttons group, after the nav buttons', () => {
    const html = withFooter();
    const spacer = html.indexOf('class="flex-1"');
    expect(spacer).toBeGreaterThan(html.indexOf('data-testid="ab-fleet"'));
    expect(html.indexOf('data-testid="title-buttons"')).toBeGreaterThan(spacer);
    expect(html.indexOf('data-testid="settings-open"')).toBeGreaterThan(html.indexOf('data-testid="title-buttons"'));
  });
  it('footer buttons keep the 44px rail style and accessible name', () => {
    const tag = buttons(withFooter()).find((b) => b.includes('settings-open')) ?? '';
    expect(classesOf(tag)).toEqual(expect.arrayContaining(['w-11', 'h-11']));
    expect(tag).toContain('aria-label="Settings"');
  });
  it('renders no footer group without footer', () => {
    expect(render()).not.toContain('title-buttons');
  });
  it('reserves a draggable strip at the top on mac for the traffic lights', () => {
    expect(render()).toMatch(/class="drag h-9[^"]*"[^>]*data-testid="ab-drag-region"/);
  });
});
