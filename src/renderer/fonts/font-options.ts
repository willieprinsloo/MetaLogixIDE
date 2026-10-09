/**
 * Pure option, validation and highlight logic for the font combobox. The
 * highlight is stored as an option identity (or none, meaning "best match for
 * the typed text") rather than an index, so it survives the option list
 * changing underneath it, and Enter on a field the user has not edited or
 * navigated resolves to no action.
 */

import type { FontFamilyPreference } from '@shared/font-settings';
import { parseFontFamilyPreference } from '@shared/font-settings';

/**
 * Longest family list rendered at once; typing narrows it further. Each row
 * draws in its own face (~2-3 ms apiece), and a Linux install with the Noto
 * set easily passes 250 families, so the cap leaves room for those.
 */
export const MAX_VISIBLE_FAMILIES = 500;

export type FontOption =
  | { readonly kind: 'default' }
  | { readonly kind: 'family'; readonly family: string }
  | { readonly kind: 'custom'; readonly family: string };

export type FontEntry =
  | { readonly ok: true; readonly value: FontFamilyPreference }
  | { readonly ok: false; readonly error: string };

export interface FontPickerState {
  readonly query: string;
  readonly open: boolean;
  readonly activeKey: string | null;
  readonly dirty: boolean;
  /** The user typed since the last reset. */
  readonly typed: boolean;
  /** The current highlight was set by the pointer, not the keyboard or typing. */
  readonly activeByPointer: boolean;
}

export type FontPickerEvent =
  | { readonly type: 'open' }
  | { readonly type: 'type'; readonly text: string }
  | { readonly type: 'highlight'; readonly key: string; readonly via?: 'pointer' }
  | { readonly type: 'close' }
  | { readonly type: 'reset'; readonly query: string };

export type EnterAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'choose'; readonly option: FontOption }
  | { readonly kind: 'commit'; readonly text: string };

const DEFAULT_OPTION: FontOption = { kind: 'default' };
const NONE: EnterAction = { kind: 'none' };

/** Whether `family` is in `families`, ignoring case. */
export function includesFamily(families: readonly string[], family: string): boolean {
  const folded = family.toLowerCase();
  return families.some((candidate) => candidate.toLowerCase() === folded);
}

function isFiltering(query: string, value: FontFamilyPreference): boolean {
  const needle = query.trim().toLowerCase();
  return needle.length > 0 && needle !== (value ?? '').toLowerCase();
}

/** Trims typed text; empty means System default, otherwise the shared family rules apply. */
export function validateFontEntry(text: string): FontEntry {
  if (text.trim().length === 0) return { ok: true, value: null };
  return parseFontFamilyPreference(text);
}

/**
 * System default, then families containing the trimmed text (all of them while
 * the field is empty or still shows the saved family), then `Use "<text>"`
 * when the text names no family exactly.
 */
export function buildFontOptions(input: { families: readonly string[]; query: string; value: FontFamilyPreference }): FontOption[] {
  const { families, query, value } = input;
  const needle = query.trim().toLowerCase();
  const filtering = isFiltering(query, value);
  const matches = filtering ? families.filter((f) => f.toLowerCase().includes(needle)) : families;
  const list: FontOption[] = [DEFAULT_OPTION];
  for (const family of matches.slice(0, MAX_VISIBLE_FAMILIES)) list.push({ kind: 'family', family });
  const typed = query.trim();
  if (filtering && !includesFamily(families, typed)) list.push({ kind: 'custom', family: typed });
  return list;
}

/** Stable identity of an option across rebuilt lists. */
export function optionKey(option: FontOption): string {
  return option.kind === 'default' ? 'default' : `${option.kind}:${option.family}`;
}

/** Index of the saved preference in the list, or -1 when it is not listed. */
export function selectedOptionIndex(options: readonly FontOption[], value: FontFamilyPreference): number {
  return options.findIndex((o) =>
    value === null ? o.kind === 'default' : o.kind !== 'default' && o.family.toLowerCase() === value.toLowerCase());
}

/** Closed, unedited state showing the saved family. */
export function initialPickerState(value: FontFamilyPreference): FontPickerState {
  return { query: value ?? '', open: false, activeKey: null, dirty: false, typed: false, activeByPointer: false };
}

/** Applies one user event; typing always opens the list with the best-match highlight. */
export function fontPickerReducer(state: FontPickerState, event: FontPickerEvent): FontPickerState {
  switch (event.type) {
    case 'open':
      return state.open ? state : { ...state, open: true, activeKey: null, activeByPointer: false };
    case 'type':
      return { ...state, query: event.text, open: true, activeKey: null, dirty: true, typed: true, activeByPointer: false };
    case 'highlight':
      return { ...state, activeKey: event.key, dirty: true, activeByPointer: event.via === 'pointer' };
    case 'close':
      return { ...state, open: false, activeKey: null, activeByPointer: false };
    case 'reset':
      return { ...initialPickerState(null), query: event.query, open: state.open };
  }
}

/** Best option for typed text: an exact name (ignoring case), then a prefix match, then the first match. */
function bestMatchIndex(options: readonly FontOption[], query: string, value: FontFamilyPreference): number {
  if (query.trim().length === 0) return 0;
  if (!isFiltering(query, value)) return Math.max(0, selectedOptionIndex(options, value));
  const needle = query.trim().toLowerCase();
  const name = (o: FontOption): string | null => (o.kind === 'family' ? o.family.toLowerCase() : null);
  const exact = options.findIndex((o) => name(o) === needle);
  if (exact >= 0) return exact;
  const prefix = options.findIndex((o) => name(o)?.startsWith(needle) === true);
  return prefix >= 0 ? prefix : Math.max(0, options.findIndex((o) => o.kind !== 'default'));
}

/** Index of the highlighted option: the explicit highlight if still listed, else the best match. */
export function activeOptionIndex(options: readonly FontOption[], state: FontPickerState, value: FontFamilyPreference): number {
  if (state.activeKey !== null) {
    const index = options.findIndex((o) => optionKey(o) === state.activeKey);
    if (index >= 0) return index;
  }
  return bestMatchIndex(options, state.query, value);
}

/** Identity of the option one step from `index`, wrapping at both ends. */
export function moveHighlight(options: readonly FontOption[], index: number, step: 1 | -1): string {
  const next = options[(index + step + options.length) % options.length];
  return optionKey(next ?? DEFAULT_OPTION);
}

/**
 * What Enter does: save the explicitly highlighted option, else the best match
 * for edited text, else nothing — an unedited field, or text that still names
 * the saved family, keeps the current font.
 */
export function resolveEnter(state: FontPickerState, options: readonly FontOption[], value: FontFamilyPreference): EnterAction {
  if (!state.dirty) return NONE;
  if (!state.open) return { kind: 'commit', text: state.query };
  const explicit = options.find((o) => optionKey(o) === state.activeKey);
  if (explicit) return { kind: 'choose', option: explicit };
  if (state.query.trim().length > 0 && !isFiltering(state.query, value)) return NONE;
  return { kind: 'choose', option: options[bestMatchIndex(options, state.query, value)] ?? DEFAULT_OPTION };
}

/** A pointer position in screen coordinates. */
export interface PointerPosition {
  readonly x: number;
  readonly y: number;
}

/**
 * True only when the pointer really moved since the previous event. Chromium
 * also sends mouse events when a list re-renders under a still pointer; those
 * must not override the highlight the user's typing chose.
 */
export function pointerMoved(previous: PointerPosition | null, next: PointerPosition): boolean {
  return previous !== null && (previous.x !== next.x || previous.y !== next.y);
}

/**
 * Leaving the field saves what Enter would, except that a highlight set only
 * by the pointer is ignored: passing over a row and clicking elsewhere must not
 * change the font. Without it, typed text resolves to its best match.
 */
export function resolveBlur(state: FontPickerState, options: readonly FontOption[], value: FontFamilyPreference): EnterAction {
  if (!state.activeByPointer) return resolveEnter(state, options, value);
  if (!state.typed) return NONE;
  return resolveEnter({ ...state, activeKey: null }, options, value);
}
