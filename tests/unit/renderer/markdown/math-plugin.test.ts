import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { mathPlugin } from '../../../../src/renderer/markdown/math/mathPlugin';
import { MATH_ERROR_CLASS } from '../../../../src/renderer/markdown/contract';

const md = new MarkdownIt().use(mathPlugin);
const mdTypo = new MarkdownIt({ typographer: true, linkify: true }).use(mathPlugin);

const render = (src: string): string => md.render(src);

function texOf(html: string): string[] {
  return [
    ...html.matchAll(/<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/g),
  ].map((m) => (m[1] ?? '').trim());
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

function expectNoMath(html: string): void {
  expect(html).not.toContain('class="katex');
  expect(html).not.toContain(MATH_ERROR_CLASS);
}

function expectDisplay(html: string, tex: string): void {
  expect(count(html, 'class="katex-display"')).toBe(1);
  expect(texOf(html)).toEqual([tex]);
}

describe('mathPlugin inline math (AC10)', () => {
  it.each([
    ['dollar', 'a $x^2$ b'],
    ['backslash paren', 'a \\(x^2\\) b'],
  ])('renders %s delimiters as inline math inside the paragraph', (_, src) => {
    const html = render(src);
    expect(html).toMatch(/^<p>a <span class="katex">[\s\S]*<\/span> b<\/p>\n$/);
    expect(html).not.toContain('katex-display');
    expect(texOf(html)).toEqual(['x^2']);
  });

  it('closes at the first valid dollar so two formulas stay separate', () => {
    expect(texOf(render('$a$ and $b$'))).toEqual(['a', 'b']);
  });

  it('keeps an escaped dollar inside the formula', () => {
    expect(texOf(render('$a\\$b$'))).toEqual(['a\\$b']);
  });

  it('treats a double backslash before the closing dollar as TeX, not an escape', () => {
    expect(texOf(render('$a\\\\$ b'))).toEqual(['a\\\\']);
  });

  it('renders an inline $$…$$ as display math within the paragraph', () => {
    const html = render('a $$x$$ b');
    expect(html).toMatch(/^<p>a <span class="katex-display">/);
    expectDisplay(html, 'x');
  });

  it('renders \\[…\\] mid-paragraph as display math', () => {
    const html = render('see \\[x^2\\] here');
    expect(html).toMatch(/^<p>see <span class="katex-display">[\s\S]*<\/span> here<\/p>/);
    expectDisplay(html, 'x^2');
  });
});

describe('mathPlugin display blocks (AC10, AC11)', () => {
  it('renders a single-line $$…$$ block as one display formula outside a paragraph', () => {
    const html = render('$$x^2$$');
    expect(html).toMatch(/^<span class="katex-display">/);
    expect(html).not.toContain('<p>');
    expectDisplay(html, 'x^2');
  });

  it('renders a multi-line $$ block as one display formula', () => {
    const html = render('$$\na = 1\n\\\\\nb = 2\n$$');
    expect(html).not.toContain('<p>');
    expectDisplay(html, 'a = 1\n\\\\\nb = 2');
  });

  it('includes text on the opening and closing delimiter lines', () => {
    expectDisplay(render('$$a +\nb$$'), 'a +\nb');
  });

  it.each([
    ['single line', '\\[x^2\\]', 'x^2'],
    ['multi line', '\\[\nx^2\n\\]', 'x^2'],
  ])('renders a \\[…\\] block (%s) as display math', (_, src, tex) => {
    const html = render(src);
    expect(html).not.toContain('<p>');
    expectDisplay(html, tex);
  });

  it('lets a $$ block interrupt a paragraph', () => {
    const html = render('text before\n$$\nx\n$$\ntext after');
    expect(html).toMatch(/^<p>text before<\/p>\n<span class="katex-display">/);
    expect(html).toMatch(/<p>text after<\/p>\n$/);
    expectDisplay(html, 'x');
  });

  it('does not interrupt a paragraph from a line indented four spaces', () => {
    const html = render('text\n    $$x$$');
    expect(html).toMatch(/^<p>text\n<span class="katex-display">[\s\S]*<\/p>\n$/);
    expectDisplay(html, 'x');
  });

  it('renders a $$ block inside a blockquote', () => {
    const html = render('> $$\n> x\n> $$');
    expect(html).toMatch(/^<blockquote>\n<span class="katex-display">[\s\S]*<\/blockquote>\n$/);
    expectDisplay(html, 'x');
  });

  it('renders a $$ block inside a list item', () => {
    const html = render('- item\n\n  $$\n  x\n  $$\n- next');
    expect(html).toMatch(
      /<li>\n<p>item<\/p>\n<span class="katex-display">[\s\S]*<\/li>\n<li>\n<p>next<\/p>/,
    );
    expectDisplay(html, 'x');
  });

  it('renders a $$ block that starts a list item', () => {
    expectDisplay(render('- $$x$$'), 'x');
  });
});

describe('mathPlugin literal dollars (AC12)', () => {
  it.each([
    ['prices', 'costs $5 and $10', '<p>costs $5 and $10</p>\n'],
    ['whitespace inside delimiters', '$ x $', '<p>$ x $</p>\n'],
    ['escaped dollar', '\\$5', '<p>$5</p>\n'],
    ['shell variable', 'echo $HOME', '<p>echo $HOME</p>\n'],
    ['digit after closer', '$x$5', '<p>$x$5</p>\n'],
    ['whitespace before closer', '$x $', '<p>$x $</p>\n'],
    ['whitespace after opener', '$ x$', '<p>$ x$</p>\n'],
    ['escaped dollars around text', '\\$x\\$', '<p>$x$</p>\n'],
  ])('leaves %s literal', (_, src, expected) => {
    const html = render(src);
    expectNoMath(html);
    expect(html).toBe(expected);
  });

  it.each([
    ['unclosed $', 'a $x b', '<p>a $x b</p>\n'],
    ['unclosed inline $$', 'a $$x b', '<p>a $$x b</p>\n'],
    ['$$ closed by a single $', '$$x$', '<p>$$x$</p>\n'],
    ['unclosed $$ block', '$$\nx', '<p>$$\nx</p>\n'],
    ['$$ block cut off by a blank line', '$$\nx\n\ny$$', '<p>$$\nx</p>\n<p>y$$</p>\n'],
    ['empty $$', '$$$$', '<p>$$$$</p>\n'],
  ])('leaves %s literal', (_, src, expected) => {
    const html = render(src);
    expectNoMath(html);
    expect(html).toBe(expected);
  });
});

describe('mathPlugin backslash delimiters (AC10a)', () => {
  it('renders matched \\(x^2\\) and \\[x^2\\] in prose as math', () => {
    const html = render('inline \\(x^2\\) and display \\[x^2\\] here');
    expect(texOf(html)).toEqual(['x^2', 'x^2']);
    expect(count(html, 'class="katex-display"')).toBe(1);
  });

  it('binds tighter than link brackets, like a code span', () => {
    const html = render('[a \\(b](u) c\\)');
    expect(html).not.toMatch(/<a[\s>]/);
    expect(texOf(html)).toEqual(['b](u) c']);
  });

  it.each([
    ['\\(', 'the regex \\( alone', '<p>the regex ( alone</p>\n'],
    ['\\[', 'the regex \\[ alone', '<p>the regex [ alone</p>\n'],
    [
      '\\( closed only in the next paragraph',
      'open \\( here\n\nclose \\) there',
      '<p>open ( here</p>\n<p>close ) there</p>\n',
    ],
    ['\\[ block closed only in the next paragraph', '\\[\nx\n\ny\\]', '<p>[\nx</p>\n<p>y]</p>\n'],
    ['mismatched pair', 'a \\( b \\] c', '<p>a ( b ] c</p>\n'],
    ['empty pair', 'a \\(\\) b \\( \\) c', '<p>a () b ( ) c</p>\n'],
    ['escaped backslash before paren', '\\\\(x\\\\)', '<p>\\(x\\)</p>\n'],
  ])('leaves unmatched %s literal with no math or error marker', (_, src, expected) => {
    const html = render(src);
    expectNoMath(html);
    expect(html).toBe(expected);
  });
});

describe('mathPlugin never inside code (AC13)', () => {
  it.each([
    ['inline code with dollars', '`$x$`', '<p><code>$x$</code></p>\n'],
    ['inline code with parens', '`\\(x\\)`', '<p><code>\\(x\\)</code></p>\n'],
    ['inline code with $$', '`$$x$$`', '<p><code>$$x$$</code></p>\n'],
  ])('leaves %s as code', (_, src, expected) => {
    const html = render(src);
    expectNoMath(html);
    expect(html).toBe(expected);
  });

  it('leaves a fenced block untouched', () => {
    const html = render('```\n$x$ \\(y\\)\n$$\nz\n$$\n\\[w\\]\n```');
    expectNoMath(html);
    expect(html).toContain('<pre><code>$x$ \\(y\\)\n$$\nz\n$$\n\\[w\\]\n</code></pre>');
  });

  it('leaves an indented code block untouched', () => {
    const html = render('    $x$ \\(y\\)\n    $$\n    z\n    $$');
    expectNoMath(html);
    expect(html).toContain('<pre><code>$x$ \\(y\\)\n$$\nz\n$$\n</code></pre>');
  });
});

describe('mathPlugin errors (AC14)', () => {
  it('marks only the invalid formula and keeps surrounding text and formulas', () => {
    const html = render('a $\\frac{1}{$ b $y$ c');
    expect(count(html, `class="${MATH_ERROR_CLASS}"`)).toBe(1);
    expect(html).toContain('>\\frac{1}{</span>');
    expect(texOf(html)).toEqual(['y']);
    expect(html).toMatch(
      /^<p>a <span class="math-error"[^>]*>[^<]*<\/span> b <span class="katex">[\s\S]* c<\/p>\n$/,
    );
  });

  it('marks an invalid display block', () => {
    const html = render('$$\n\\frac{1}{\n$$');
    expect(count(html, `class="${MATH_ERROR_CLASS}"`)).toBe(1);
  });

  it('escapes HTML in invalid formulas', () => {
    const html = render('$<script>alert(1)</script>\\frac{$ and \\(<img onerror=x>\\frac{\\)');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(count(html, `class="${MATH_ERROR_CLASS}"`)).toBe(2);
  });
});

describe('mathPlugin with typographer and linkify', () => {
  it.each([
    ['dashes in $…$', '$a--b$', 'a--b'],
    ['dashes in \\(…\\)', '\\(a--b\\)', 'a--b'],
    ['quotes and ellipsis', "$f'(x)...$", 'f&#x27;(x)...'],
    ['url-like text', '$http://x.com$', 'http://x.com'],
  ])('leaves %s unchanged', (_, src, tex) => {
    const html = mdTypo.render(src);
    expect(texOf(html)).toEqual([tex]);
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).not.toContain('–');
    expect(html).not.toContain('…');
  });

  it('still applies typographer and linkify to the surrounding prose', () => {
    const html = mdTypo.render('a--b $x$ http://x.com');
    expect(html).toContain('a–b');
    expect(html).toContain('<a href="http://x.com">');
    expect(texOf(html)).toEqual(['x']);
  });
});

describe('mathPlugin scan cost', () => {
  const COUNT = 16_000;
  const BUDGET_MS = 150;
  const series = (item: (i: number) => string): string =>
    Array.from({ length: COUNT }, (_, i) => item(i)).join(' ');

  function timed(src: string): { html: string; ms: number } {
    const started = performance.now();
    const html = render(src);
    return { html, ms: performance.now() - started };
  }

  it.each([
    ['prices', series((i) => `$${i}`), (s: string) => s],
    ['closers rejected by a digit', series((i) => `$a$${i}`), (s: string) => s],
    ['unmatched \\(', series(() => '\\(a'), (s: string) => s.replaceAll('\\(', '(')],
    ['unmatched \\[', series(() => '\\[a'), (s: string) => s.replaceAll('\\[', '[')],
    ['one unclosed $$ before prices', `$$ ${series((i) => `$${i}`)}`, (s: string) => s],
  ])('renders a paragraph of %s in linear time with unchanged output', (_, src, literal) => {
    render(src);
    const { html, ms } = timed(src);
    expect(html).toBe(`<p>${literal(src)}</p>\n`);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('still finds closers of other kinds after many failed openers', () => {
    const prices = series((i) => `$${i}`);
    expect(texOf(render(`$$z$$ ${series(() => '\\[a')} ${prices} \\(y\\)`))).toEqual(['z', 'y']);
    expect(texOf(render(`${series(() => '\\(a')} $x$`))).toEqual(['x']);
  });
});
