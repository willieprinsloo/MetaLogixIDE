import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import { mathPlugin } from './math/mathPlugin';
import { installFenceRule } from './fenceRule';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: true,
  highlight: (str: string, lang: string) => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
      } catch {
        /* fall through */
      }
    }
    return ''; // skip auto-detection — much slower than knowing the fence lang
  },
});

md.use(mathPlugin);
installFenceRule(md);

/** Renders Markdown source to the preview's HTML string. */
export function renderMarkdown(source: string): string {
  return md.render(source);
}
