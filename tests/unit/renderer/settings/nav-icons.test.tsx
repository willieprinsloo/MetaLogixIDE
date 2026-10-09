import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  NavIcon,
  SectionButton,
  type SettingsSection,
} from '@renderer/components/settings/nav-icons';
import { APP_ENV_COPY, APP_ENV_TESTIDS, ENV_COPY } from '@renderer/project-env-copy';

const SECTIONS: readonly SettingsSection[] = ['general', 'roots', 'launch', 'env', 'metaproject'];

const ENV_GLYPH = 'M8 4H7a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h1';

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

function svgTag(html: string): string {
  const match = /<svg[^>]*>/.exec(html);
  if (!match) throw new Error(`no svg in ${html}`);
  return match[0];
}

function renderItem(section: SettingsSection, active: boolean, label: string): string {
  return renderToStaticMarkup(
    <SectionButton section={section} active={active} onClick={() => {}}>
      {label}
    </SectionButton>,
  );
}

describe('NavIcon', () => {
  it.each(SECTIONS)('renders a 15x15 svg hidden from assistive tech for %s', (section) => {
    const svg = svgTag(renderToStaticMarkup(<NavIcon section={section} />));
    expect(svg).toContain('width="15"');
    expect(svg).toContain('height="15"');
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain('stroke="currentColor"');
  });

  it('draws a distinct icon for every section', () => {
    const shapes = SECTIONS.map((section) =>
      renderToStaticMarkup(<NavIcon section={section} />).replace(/<span[^>]*>|<\/span>/g, ''),
    );
    expect(new Set(shapes).size).toBe(SECTIONS.length);
  });

  it.each([
    ['general', '<circle cx="16" cy="6" r="2">'],
    ['roots', 'M3 7a2 2 0 0 1 2-2h4l2 2h8'],
    ['launch', 'M4 17l6-5-6-5M12 19h8'],
    ['env', ENV_GLYPH],
    ['metaproject', '<rect x="3" y="4" width="18" height="16" rx="2">'],
  ] as const)('draws the agreed glyph for %s', (section, glyph) => {
    const html = renderToStaticMarkup(<NavIcon section={section} />);
    expect(html).toContain(glyph);
    for (const other of SECTIONS.filter((s) => s !== section)) {
      expect(renderToStaticMarkup(<NavIcon section={other} />)).not.toContain(glyph);
    }
  });

  it('carries no text of its own', () => {
    for (const section of SECTIONS) {
      expect(textOf(renderToStaticMarkup(<NavIcon section={section} />))).toBe('');
    }
  });
});

describe('SectionButton', () => {
  it('marks the active item as the current page', () => {
    const html = renderItem('general', true, 'General');
    expect(html).toMatch(/^<button[^>]*aria-current="page"/);
  });

  it('leaves aria-current off inactive items', () => {
    expect(renderItem('roots', false, 'Root directories')).not.toContain('aria-current');
  });

  it.each([
    ['general', 'General'],
    ['roots', 'Root directories'],
    ['launch', 'Launch commands'],
    ['env', 'Environment'],
    ['metaproject', 'Metaproject'],
  ] as const)('names the %s item exactly "%s"', (section, label) => {
    const html = renderItem(section, false, label);
    expect(textOf(html)).toBe(label);
    expect(html).not.toMatch(/<button[^>]*aria-label=/);
  });

  it('shows the section icon before the label', () => {
    const html = renderItem('launch', false, 'Launch commands');
    expect(html.indexOf('<svg')).toBeGreaterThan(-1);
    expect(html.indexOf('<svg')).toBeLessThan(html.indexOf('Launch commands'));
  });

  it.each([true, false])(
    'sets the label at 13px on one line, truncating rather than wrapping (active=%s)',
    (active) => {
      const html = renderItem('launch', active, 'Launch commands');
      const button = /^<button[^>]*class="([^"]*)"/.exec(html)?.[1]?.split(/\s+/) ?? [];
      expect(button).toContain('text-[13px]');
      expect(button).not.toContain('text-sm');
      expect(button).toContain('whitespace-nowrap');
      const label =
        /<span class="([^"]*)">Launch commands<\/span>/.exec(html)?.[1]?.split(/\s+/) ?? [];
      expect(label).toContain('truncate');
      expect(label).toContain('min-w-0');
    },
  );

  it('names an item with unsaved changes by unsavedLabel and shows the hidden marker (AC7)', () => {
    const html = renderToStaticMarkup(
      <SectionButton
        section="env"
        active={false}
        onClick={() => {}}
        unsavedLabel={APP_ENV_COPY.navUnsavedLabel}
      >
        {APP_ENV_COPY.navLabel}
      </SectionButton>,
    );
    expect(html).toMatch(new RegExp(`^<button[^>]*aria-label="${APP_ENV_COPY.navUnsavedLabel}"`));
    expect(html).toMatch(
      new RegExp(
        `<span[^>]*aria-hidden="true"[^>]*data-testid="${APP_ENV_TESTIDS.unsaved}"[^>]*>${ENV_COPY.tabUnsavedMarker}</span>`,
      ),
    );
    expect(html.indexOf(APP_ENV_COPY.navLabel)).toBeLessThan(
      html.indexOf(ENV_COPY.tabUnsavedMarker),
    );
  });

  it('shows no marker without unsavedLabel', () => {
    const html = renderItem('env', false, APP_ENV_COPY.navLabel);
    expect(html).not.toContain(APP_ENV_TESTIDS.unsaved);
    expect(textOf(html)).toBe(APP_ENV_COPY.navLabel);
  });

  it('is a plain button so it never submits a form', () => {
    expect(renderItem('general', false, 'General')).toMatch(/^<button[^>]*type="button"/);
  });
});
