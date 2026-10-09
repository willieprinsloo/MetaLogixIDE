import { describe, it, expect, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EnvValueField, type EnvValueLabels } from '@renderer/components/env/EnvValueField';
import { Tooltip } from '@renderer/components/Tooltip';
import { ENV_COPY, ENV_TESTIDS } from '@renderer/project-env-copy';

type Props = Record<string, unknown> & { children?: ReactNode };
type FieldProps = Parameters<typeof EnvValueField>[0];

const SECRET = 'S3CR3T-ghp_value';

const labels: EnvValueLabels = {
  value: ENV_COPY.valueLabel(2),
  reveal: ENV_COPY.revealLabel(2),
  hide: ENV_COPY.hideLabel(2),
  copy: ENV_COPY.copyLabel(2),
};

function props(over: Partial<FieldProps> = {}): FieldProps {
  return {
    value: SECRET,
    labels,
    revealed: false,
    onToggle: vi.fn(),
    onCopy: vi.fn(),
    onChange: vi.fn(),
    testId: ENV_TESTIDS.value,
    ...over,
  };
}

function render(over: Partial<FieldProps> = {}): string {
  return renderToStaticMarkup(<EnvValueField {...props(over)} />);
}

function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  if (typeof node.type === 'function' && node.type !== Tooltip) {
    return [node, ...elements((node.type as (p: Props) => ReactNode)(node.props))];
  }
  return [node, ...elements(node.props.children)];
}

function tree(p: FieldProps): ReactElement<Props>[] {
  return elements(EnvValueField(p));
}

function byTestId(p: FieldProps, testId: string): ReactElement<Props> {
  const found = tree(p).find((el) => el.props['data-testid'] === testId);
  if (!found) throw new Error(`no element with data-testid=${testId}`);
  return found;
}

function tagWith(html: string, tag: string, testId: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*data-testid="${testId}"[^>]*>`).exec(html);
  if (!match) throw new Error(`no <${tag}> with data-testid=${testId} in ${html}`);
  return match[0];
}

describe('EnvValueField masking (AC20)', () => {
  it('renders a masked value as a password input', () => {
    expect(tagWith(render(), 'input', ENV_TESTIDS.value)).toContain('type="password"');
  });

  it('renders a revealed value as a text input', () => {
    expect(tagWith(render({ revealed: true }), 'input', ENV_TESTIDS.value)).toContain(
      'type="text"',
    );
  });

  it('puts the value only in the input value attribute', () => {
    for (const revealed of [false, true]) {
      const html = render({ revealed });
      expect(tagWith(html, 'input', ENV_TESTIDS.value)).toContain(`value="${SECRET}"`);
      expect(html.split(SECRET)).toHaveLength(2);
      expect(html.replace(`value="${SECRET}"`, '')).not.toContain(SECRET);
    }
  });
});

describe('EnvValueField reveal toggle (AC21)', () => {
  it('names the toggle "Show value, row N" while masked', () => {
    const button = tagWith(render(), 'button', ENV_TESTIDS.reveal);
    expect(button).toContain(`aria-label="${ENV_COPY.revealLabel(2)}"`);
  });

  it('names the toggle "Hide value, row N" while revealed', () => {
    const button = tagWith(render({ revealed: true }), 'button', ENV_TESTIDS.reveal);
    expect(button).toContain(`aria-label="${ENV_COPY.hideLabel(2)}"`);
  });

  it('never sets aria-pressed', () => {
    expect(render()).not.toContain('aria-pressed');
    expect(render({ revealed: true })).not.toContain('aria-pressed');
  });

  it('switches the tooltip with the state', () => {
    const tip = (revealed: boolean) =>
      tree(props({ revealed })).find(
        (el) => typeof el.props.label === 'string' && el.props.label !== ENV_COPY.copyTooltip,
      )?.props.label;
    expect(tip(false)).toBe(ENV_COPY.revealTooltip);
    expect(tip(true)).toBe(ENV_COPY.hideTooltip);
  });

  it('calls onToggle only when activated, never onCopy', () => {
    const p = props();
    (byTestId(p, ENV_TESTIDS.reveal).props.onClick as () => void)();
    expect(p.onToggle).toHaveBeenCalledTimes(1);
    expect(p.onCopy).not.toHaveBeenCalled();
  });

  it('is a plain button', () => {
    expect(tagWith(render(), 'button', ENV_TESTIDS.reveal)).toContain('type="button"');
  });
});

describe('EnvValueField copy (AC28, AC29, AC31)', () => {
  it('names the copy button "Copy value, row N"', () => {
    const button = tagWith(render(), 'button', ENV_TESTIDS.copy);
    expect(button).toContain(`aria-label="${ENV_COPY.copyLabel(2)}"`);
    expect(button).toContain('type="button"');
  });

  it('disables copy while the value is empty', () => {
    expect(tagWith(render({ value: '' }), 'button', ENV_TESTIDS.copy)).toContain('disabled=""');
  });

  it('enables copy for a non-empty value, masked or revealed', () => {
    expect(tagWith(render(), 'button', ENV_TESTIDS.copy)).not.toContain('disabled=""');
    expect(tagWith(render({ revealed: true }), 'button', ENV_TESTIDS.copy)).not.toContain(
      'disabled=""',
    );
  });

  it('calls onCopy without toggling the reveal state', () => {
    const p = props();
    (byTestId(p, ENV_TESTIDS.copy).props.onClick as () => void)();
    expect(p.onCopy).toHaveBeenCalledTimes(1);
    expect(p.onToggle).not.toHaveBeenCalled();
  });

  it('carries a copy tooltip', () => {
    expect(tree(props()).some((el) => el.props.label === ENV_COPY.copyTooltip)).toBe(true);
  });
});

describe('EnvValueField editing (AC26, AC27)', () => {
  it('is editable and reports the typed value through onChange', () => {
    const p = props();
    const input = byTestId(p, ENV_TESTIDS.value);
    expect(input.props.readOnly).toBeFalsy();
    (input.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: 'typed' },
    });
    expect(p.onChange).toHaveBeenCalledWith('typed');
    expect(p.onToggle).not.toHaveBeenCalled();
  });

  it('is read-only without onChange', () => {
    const p = props({ onChange: undefined });
    expect(tagWith(render({ onChange: undefined }), 'input', ENV_TESTIDS.value)).toContain(
      'readonly=""',
    );
    expect(byTestId(p, ENV_TESTIDS.value).props.onChange).toBeUndefined();
  });

  it('keeps a read-only input out of the tab order, an editable one in it', () => {
    expect(tagWith(render({ onChange: undefined }), 'input', ENV_TESTIDS.value)).toContain(
      'tabindex="-1"',
    );
    expect(tagWith(render(), 'input', ENV_TESTIDS.value)).not.toContain('tabindex');
  });

  it('names the input with the value label', () => {
    expect(tagWith(render(), 'input', ENV_TESTIDS.value)).toContain(
      `aria-label="${ENV_COPY.valueLabel(2)}"`,
    );
  });

  it('marks the input invalid and describes it by the reason when reasonId is set', () => {
    const input = tagWith(render({ reasonId: 'why-1' }), 'input', ENV_TESTIDS.value);
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-describedby="why-1"');
  });

  it('is neither invalid nor described without reasonId', () => {
    const input = tagWith(render(), 'input', ENV_TESTIDS.value);
    expect(input).not.toContain('aria-invalid');
    expect(input).not.toContain('aria-describedby');
  });
});

describe('EnvValueField order (AC33)', () => {
  it('renders input, then reveal, then copy', () => {
    const html = render();
    const at = (id: string) => html.indexOf(`data-testid="${id}"`);
    expect(at(ENV_TESTIDS.value)).toBeGreaterThan(-1);
    expect(at(ENV_TESTIDS.value)).toBeLessThan(at(ENV_TESTIDS.reveal));
    expect(at(ENV_TESTIDS.reveal)).toBeLessThan(at(ENV_TESTIDS.copy));
  });
});
