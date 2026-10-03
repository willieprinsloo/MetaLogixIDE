/**
 * Effective light/dark theme as the stylesheet sees it: `<html data-theme>`
 * when set, otherwise the OS `prefers-color-scheme`. Reads the DOM rather than
 * `useTheme` because each `useTheme` caller holds its own state, so a change
 * made in Settings would not reach a value threaded from App.
 */
import { useEffect, useState } from 'react';
import type { EffectiveTheme } from '@renderer/markdown/contract';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function readTheme(): EffectiveTheme {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/** Effective light/dark theme, re-rendering when `data-theme` or the OS preference changes. */
export function useDocumentTheme(): EffectiveTheme {
  const [theme, setTheme] = useState<EffectiveTheme>(readTheme);

  useEffect(() => {
    const update = (): void => setTheme(readTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    const media = window.matchMedia(DARK_QUERY);
    media.addEventListener('change', update);
    update();
    return () => {
      observer.disconnect();
      media.removeEventListener('change', update);
    };
  }, []);

  return theme;
}
