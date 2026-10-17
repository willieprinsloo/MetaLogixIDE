import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FrostLevelRow } from '@renderer/components/settings/FrostLevelRow';
import { FROSTED_GLASS_COPY } from '@renderer/frosted-chrome-contract';
import { CHROME_FROST_LEVELS } from '@shared/frosted-glass';

function row(disabled: boolean, onChange = vi.fn()): string {
  return renderToStaticMarkup(
    <FrostLevelRow
      label="Chrome frost"
      options={CHROME_FROST_LEVELS}
      value="medium"
      disabled={disabled}
      testId="chrome-level"
      onChange={onChange}
    />,
  );
}

describe('FrostLevelRow (gate M2, L8)', () => {
  it('renders the visible label and a radiogroup named by it, with the level copy', () => {
    const html = row(false);
    expect(html).toContain('>Chrome frost<');
    expect(html).toMatch(/role="radiogroup" aria-label="Chrome frost"/);
    for (const level of CHROME_FROST_LEVELS) expect(html).toContain(`>${FROSTED_GLASS_COPY.levels[level]}<`);
    expect(html).toContain('data-testid="chrome-level"');
  });

  it('disabled: shows "Needs Frosted chrome" and links it to the radiogroup with aria-describedby', () => {
    const html = row(true);
    const describedBy = /role="radiogroup"[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toMatch(new RegExp(`id="${describedBy}"[^>]*>${FROSTED_GLASS_COPY.disabledReason}<`));
  });

  it('enabled: no hint and no aria-describedby', () => {
    const html = row(false);
    expect(html).not.toContain(FROSTED_GLASS_COPY.disabledReason);
    expect(html).not.toContain('aria-describedby');
  });
});
