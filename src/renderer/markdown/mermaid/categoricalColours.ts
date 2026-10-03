/**
 * Picks the categorical colours (pie slices, gitGraph branches, journey
 * actors) from the app's own hues. Each seed is fitted to the theme's
 * contrast rules; a seed that lands too close to an earlier pick is turned
 * round the hue wheel, then shifted in lightness, in widening steps until it
 * stands apart by the CIEDE2000 distance the spec requires.
 */
import { hslLightness, linearChannel, rotateHue, withLightness } from './colour';
import { MIN_CATEGORY_DELTA_E, type Rgb } from './paletteContract';

/** Head-room over the spec's ΔE bar, so rounding in any consumer cannot drop a pair below it. */
const DELTA_E_MARGIN = 0.5;
const ROTATIONS = [0, 15, -15, 30, -30, 45, -45, 60, -60, 90, -90, 120, -120, 150, -150, 180];
const LIGHTNESS_SHIFTS = [0, 0.08, -0.08, 0.16, -0.16, 0.24, -0.24];
const RAD = Math.PI / 180;

type Lab = [number, number, number];

function toLab({ r, g, b }: Rgb): Lab {
  const [lr, lg, lb] = [linearChannel(r), linearChannel(g), linearChannel(b)];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116);
  const fx = f((0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047);
  const fy = f(0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb);
  const fz = f((0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function primeHue(a: number, b: number): number {
  const h = Math.atan2(b, a) / RAD;
  return h < 0 ? h + 360 : h;
}

function wrapHueDifference(d: number): number {
  if (d > 180) return d - 360;
  return d < -180 ? d + 360 : d;
}

function meanHue(h1: number, h2: number): number {
  const sum = h1 + h2;
  if (Math.abs(h1 - h2) <= 180) return sum / 2;
  return sum < 360 ? (sum + 360) / 2 : (sum - 360) / 2;
}

/** CIEDE2000 colour difference (kL = kC = kH = 1) between two sRGB colours. */
export function deltaE2000(x: Rgb, y: Rgb): number {
  const [L1, a1, b1] = toLab(x);
  const [L2, a2, b2] = toLab(y);
  const c7 = ((Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2) ** 7;
  const g = 1 + 0.5 * (1 - Math.sqrt(c7 / (c7 + 25 ** 7)));
  const [c1, c2] = [Math.hypot(g * a1, b1), Math.hypot(g * a2, b2)];
  const [h1, h2] = [primeHue(g * a1, b1), primeHue(g * a2, b2)];
  const chromatic = c1 * c2 !== 0;
  const dh = chromatic ? wrapHueDifference(h2 - h1) : 0;
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin((dh / 2) * RAD);
  const lBar = (L1 + L2) / 2;
  const cBar = (c1 + c2) / 2;
  const hBar = chromatic ? meanHue(h1, h2) : h1 + h2;
  const t =
    1 -
    0.17 * Math.cos((hBar - 30) * RAD) +
    0.24 * Math.cos(2 * hBar * RAD) +
    0.32 * Math.cos((3 * hBar + 6) * RAD) -
    0.2 * Math.cos((4 * hBar - 63) * RAD);
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cBar;
  const sh = 1 + 0.015 * cBar * t;
  const rt =
    -2 *
    Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)) *
    Math.sin(60 * Math.exp(-(((hBar - 275) / 25) ** 2)) * RAD);
  const [dl, dc, dhs] = [(L2 - L1) / sl, (c2 - c1) / sc, dH / sh];
  return Math.sqrt(dl ** 2 + dc ** 2 + dhs ** 2 + rt * dc * dhs);
}

function* candidates(seed: Rgb): Generator<Rgb> {
  for (const shift of LIGHTNESS_SHIFTS) {
    for (const turn of ROTATIONS) {
      const turned = rotateHue(seed, turn);
      yield shift === 0 ? turned : withLightness(turned, hslLightness(turned) + shift);
    }
  }
}

/** A categorical seed: the theme token it comes from and its opaque colour. */
export interface CategorySeed {
  token: `--${string}`;
  colour: Rgb;
}

/** No categorical colour can be drawn from `token` under the theme's rules; `reason` names the unmet one. */
export class CategoricalColourError extends Error {
  constructor(
    readonly token: `--${string}`,
    reason: string,
  ) {
    super(`Theme token ${token} gives no usable categorical colour: ${reason}`);
    this.name = 'CategoricalColourError';
  }
}

function pickFor(
  seed: CategorySeed,
  fit: (candidate: Rgb) => Rgb | null,
  taken: readonly Rgb[],
  minimum: number,
): Rgb {
  let anyFit = false;
  for (const candidate of candidates(seed.colour)) {
    const fitted = fit(candidate);
    anyFit ||= fitted !== null;
    if (fitted && taken.every((p) => deltaE2000(p, fitted) >= minimum)) return fitted;
  }
  throw new CategoricalColourError(
    seed.token,
    anyFit
      ? `every hue turn and lightness shift that meets the contrast rules is within CIEDE2000 ${minimum} of an earlier category or a reserved colour`
      : 'no hue turn or lightness shift of it meets the contrast rules on the diagram backgrounds',
  );
}

/**
 * One colour per seed, in seed order. `fit` moves a candidate to meet the
 * theme's contrast rules, or returns `null` when it cannot. Each pick is the
 * first candidate (smallest hue turn, then smallest lightness shift) that
 * fits and is at least the spec's ΔE from every earlier pick and from every
 * `reserved` colour (kept for other meanings, such as errors). Throws
 * `CategoricalColourError`, naming the seed's token and the unmet rule, when
 * a seed has no such candidate.
 */
export function categoricalColours(
  seeds: readonly CategorySeed[],
  fit: (candidate: Rgb) => Rgb | null,
  reserved: readonly Rgb[] = [],
): Rgb[] {
  const minimum = MIN_CATEGORY_DELTA_E + DELTA_E_MARGIN;
  const picks: Rgb[] = [];
  for (const seed of seeds) picks.push(pickFor(seed, fit, [...reserved, ...picks], minimum));
  return picks;
}
