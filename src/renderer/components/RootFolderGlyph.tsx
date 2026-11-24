/**
 * A root folder's display: its trailing-segment name and the folder glyph tinted with its stable hue
 * (see root-hue.ts). Shared by the sidebar's root headings and the command palette's project rows.
 */
import { ICON_SIZE } from './icon-size';

/** Human-friendly folder name for a root — the trailing segment of the path.
 * Dropping the `~/D/` prefix: single-letter parent abbreviations plus CSS
 * truncation made the row read as "~/D/Pro" / "~/D/my" / etc. which users
 * perceived as weird-char noise. The full absolute path still lives in the
 * row's `title=` tooltip for anyone who wants to see where it points. */
export function rootFolderName(path: string): string {
  const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/';
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/u, '') : path;
  const last = trimmed.split(sep).pop();
  return last && last.length > 0 ? last : trimmed;
}

/** Folder glyph tinted with the root's stable hue. `testId` defaults to the sidebar's "root-hue"; null omits it. */
export function RootFolderGlyph({ color, testId = 'root-hue' }: { color: string; testId?: string | null }) {
  return (
    <svg aria-hidden data-testid={testId ?? undefined} width={ICON_SIZE.sm} height={ICON_SIZE.sm} viewBox="0 0 24 24" fill={color} fillOpacity={0.25} stroke={color} strokeWidth="1.8" strokeLinejoin="round" className="shrink-0">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
