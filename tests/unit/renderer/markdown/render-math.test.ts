import { describe, expect, it } from 'vitest';
import { renderMath } from '../../../../src/renderer/markdown/math/renderMath';
import { MATH_ERROR_CLASS } from '../../../../src/renderer/markdown/contract';

const ERROR_SPAN = new RegExp(`^<span class="${MATH_ERROR_CLASS}" title="([^"]*)">([^<]*)</span>$`);

function errorParts(html: string): { title: string; body: string } {
  const match = ERROR_SPAN.exec(html);
  if (!match) throw new Error(`not a math-error span: ${html}`);
  return { title: match[1] ?? '', body: match[2] ?? '' };
}

describe('renderMath', () => {
  it('renders inline math as a KaTeX span without display wrapper', () => {
    const html = renderMath('x^2', false);
    expect(html).toMatch(/^<span class="katex">/);
    expect(html).not.toContain('katex-display');
    expect(html).toContain('<annotation encoding="application/x-tex">x^2</annotation>');
  });

  it('renders display math inside a katex-display wrapper', () => {
    const html = renderMath('x^2', true);
    expect(html).toMatch(/^<span class="katex-display">/);
  });

  it('emits both HTML and MathML output', () => {
    const html = renderMath('a+b', false);
    expect(html).toContain('class="katex-mathml"');
    expect(html).toContain('class="katex-html"');
  });

  it('renders an invalid formula as a math-error span with source and message', () => {
    const { title, body } = errorParts(renderMath('\\frac{1}{', false));
    expect(body).toBe('\\frac{1}{');
    expect(title).toContain('KaTeX parse error');
    expect(title).toContain('Unexpected end of input');
  });

  it('renders the error span for display math too', () => {
    expect(() => errorParts(renderMath('\\frac{1}{', true))).not.toThrow();
  });

  it('escapes HTML in the error source and the error title', () => {
    const html = renderMath('<script>alert("x")</script>\\frac{', false);
    const { title, body } = errorParts(html);
    expect(html).not.toContain('<script');
    expect(body).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(title).not.toMatch(/[<>"]/);
  });

  it('escapes ampersands and quotes so the title attribute cannot be broken out of', () => {
    const { body } = errorParts(renderMath('" onmouseover="x & \\frac{', false));
    expect(body).toBe('&quot; onmouseover=&quot;x &amp; \\frac{');
  });

  it('rejects untrusted commands that would emit links or HTML attributes', () => {
    const cases = [
      '\\href{javascript:alert(1)}{x}',
      '\\url{javascript:alert(1)}',
      '\\htmlClass{pwned}{y}',
      '\\htmlData{pwned=1}{y}',
      '\\htmlId{pwned}{y}',
      '\\htmlStyle{color:red}{y}',
      '\\includegraphics{pwned.png}',
    ];
    for (const tex of cases) {
      const html = renderMath(tex, false);
      expect(html, tex).not.toMatch(/<a[\s>]/);
      expect(html, tex).not.toMatch(/\shref=/);
      expect(html, tex).not.toMatch(/<img/);
      expect(html, tex).not.toMatch(/class="[^"]*pwned/);
      expect(html, tex).not.toMatch(/\sid="pwned"/);
      expect(html, tex).not.toMatch(/data-pwned/);
      expect(html, tex).not.toMatch(/style="[^"]*color:red/);
    }
  });

  it('caps macro expansion at 1000 steps', () => {
    const html = renderMath(`\\def\\a{x}${'\\a'.repeat(1200)}`, false);
    expect(errorParts(html).title).toContain('Too many expansions');
  });

  it('caps user-specified sizes at 20em', () => {
    const html = renderMath('\\rule{100em}{1em}', false);
    expect(html).toContain('border-right-width:20em');
    expect(html).toContain('width="20em"');
    expect(html).not.toMatch(/width(:|=")100em/);
  });
});
