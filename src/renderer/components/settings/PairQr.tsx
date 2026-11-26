import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** Quiet zone around the code, in modules; scanners need 4. */
const QUIET = 4;

/**
 * A QR code for `value`, always dark on white whatever the theme, so phone cameras read it.
 * Drawn as one SVG path; nothing is rendered when the value cannot be encoded.
 */
export function PairQr({ value, size = 184, label }: { value: string; size?: number; label: string }) {
  const qr = useMemo(() => {
    try {
      const q = qrcode(0, 'M'); // type 0: smallest version that fits
      q.addData(value);
      q.make();
      const n = q.getModuleCount();
      let d = '';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
      return { d, total: n + QUIET * 2 };
    } catch {
      return null;
    }
  }, [value]);
  if (!qr) return null;
  // Sized by its box, not by the icon scale: this is a scannable symbol, not an icon.
  return (
    <div className="shrink-0 overflow-hidden rounded-lg" style={{ width: size, height: size }}>
      <svg
        data-testid="p2p-pair-qr"
        data-value={value}
        role="img"
        aria-label={label}
        width="100%"
        height="100%"
        viewBox={`0 0 ${qr.total} ${qr.total}`}
        shapeRendering="crispEdges"
      >
        <rect width={qr.total} height={qr.total} fill="#ffffff" />
        <path d={qr.d} fill="#000000" />
      </svg>
    </div>
  );
}
