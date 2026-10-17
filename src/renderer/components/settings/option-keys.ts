const STEP: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/** Arrow-key navigation helper for radiogroups: index of the option to focus next (arrows step through `count` options with wrap-around), or null when `key` is not a move. */
export function nextOptionIndex(current: number, count: number, key: string): number | null {
  const step = Object.hasOwn(STEP, key) ? STEP[key] : undefined;
  if (step === undefined) return null;
  return (current + step + count) % count;
}
