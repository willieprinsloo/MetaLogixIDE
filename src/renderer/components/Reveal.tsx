import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

// Keep in sync with --ease-out in styles.css (WAAPI can't read CSS vars).
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
export const REVEAL_IN_MS = 220;
export const REVEAL_OUT_MS = 160;

const HIDDEN: Keyframe = { clipPath: 'inset(0 100% 0 0)', opacity: 0 };
const SHOWN: Keyframe = { clipPath: 'inset(0 0% 0 0)', opacity: 1 };

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Mounts its children with a clip-path unroll from the left edge, and plays
 * it back into that edge before unmounting.
 *
 * Driven by WAAPI rather than a CSS class so no clip-path survives at rest —
 * a resting clip would cut off fixed-position descendants such as context
 * menus and the terminal hover preview. clip-path (not transform) also keeps
 * xterm's canvas crisp while it moves.
 *
 * `animate` is read when `show` flips: pass false for keyboard-initiated
 * toggles so they stay instant. The initial mount never animates. Flipping
 * `show` mid-animation reverses from the current frame.
 */
export function Reveal({ show, animate, className, children }: {
  show: boolean;
  animate: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const anim = useRef<Animation | null>(null);
  const prevShow = useRef(show);
  const [present, setPresent] = useState(show);

  // Render-time sync: mount immediately on show; unmount immediately when
  // hiding without animation. An animated hide keeps us mounted until the
  // exit finishes (see effect below).
  if (show && !present) setPresent(true);
  if (!show && present && !animate) setPresent(false);

  useLayoutEffect(() => {
    // Compare against the last value rather than skipping the first run, so
    // StrictMode's effect replay doesn't animate the initial mount.
    if (prevShow.current === show) return;
    prevShow.current = show;
    const el = ref.current;
    if (!el) return;

    // Start from wherever a running animation currently is.
    const running = anim.current;
    let from: Keyframe | null = null;
    if (running && running.playState === 'running') {
      const cs = getComputedStyle(el);
      from = { clipPath: cs.clipPath, opacity: cs.opacity };
    }
    running?.cancel();
    anim.current = null;
    if (!animate) return;

    const fade = reducedMotion();
    const target = show ? SHOWN : HIDDEN;
    const start = from ?? (show ? HIDDEN : SHOWN);
    const frames = fade
      ? [{ opacity: start.opacity }, { opacity: target.opacity }]
      : [start, target];
    const a = el.animate(frames, {
      duration: show ? REVEAL_IN_MS : REVEAL_OUT_MS,
      easing: EASE_OUT,
      fill: show ? 'none' : 'forwards',
    });
    anim.current = a;
    if (!show) {
      a.onfinish = () => { if (anim.current === a) { anim.current = null; setPresent(false); } };
    }
  }, [show]); // eslint-disable-line react-hooks/exhaustive-deps -- `animate` is sampled when `show` flips

  useLayoutEffect(() => () => anim.current?.cancel(), []);

  if (!present) return null;
  return <div ref={ref} className={className}>{children}</div>;
}
