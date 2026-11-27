/**
 * Shortcut label formatting: one platform-neutral `ShortcutDef` rendered in each platform's
 * notation. Mac uses glyphs in `⌃⌥⌘⇧` order (⌘ before ⇧, as every shipped label reads) with
 * Enter as `↩`, giving `⌘⇧K`; every other platform uses `+`-joined text in `Ctrl+Alt+Shift`
 * order with Enter as `Enter`, where `ctrl` and `mod` collapse into one `Ctrl`. Letter keys are
 * upper-cased; punctuation is shown as typed.
 */
import type { FormatShortcutFn, ShortcutDef, ShortcutPlatform } from './shortcut-contract';

const KEY_NAMES: Readonly<Record<ShortcutPlatform, Readonly<Record<string, string>>>> = {
  mac: { Enter: '↩' },
  win: { Enter: 'Enter' },
  linux: { Enter: 'Enter' },
};

function keyName(key: string, platform: ShortcutPlatform): string {
  return KEY_NAMES[platform][key] ?? key.toUpperCase();
}

function macParts(def: ShortcutDef): string[] {
  return [def.ctrl && '⌃', def.alt && '⌥', def.mod && '⌘', def.shift && '⇧'].filter(
    (p): p is string => !!p,
  );
}

function otherParts(def: ShortcutDef): string[] {
  return [(def.ctrl || def.mod) && 'Ctrl', def.alt && 'Alt', def.shift && 'Shift'].filter(
    (p): p is string => !!p,
  );
}

export const formatShortcut: FormatShortcutFn = (def, platform) =>
  platform === 'mac'
    ? [...macParts(def), keyName(def.key, platform)].join('')
    : [...otherParts(def), keyName(def.key, platform)].join('+');
