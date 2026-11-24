/**
 * OSC-8 hyperlink dispatch for the shell terminal. xterm.js recognises the
 * ESC ] 8 ; ; URL BEL … ESC ] 8 ; ; BEL sequence and renders its payload
 * as styled text, but clicks go nowhere unless the Terminal is given a
 * `linkHandler`.
 *
 * Routing: `file://` URLs (and bare absolute paths) that resolve inside a
 * known project open in the IDE's Files tab — so an HTML page renders with
 * its CSS and relative assets intact via the `metafile://` protocol, an
 * image shows in the image viewer, a markdown file renders its preview.
 * Everything else — http(s), mailto, file:// paths outside every project
 * root — falls back to the OS default handler via `app:open-external`.
 */
const SAFE_SCHEME = /^(https?|mailto|file):/i;

export interface HyperlinkRouter {
  invokeOpenExternal: (url: string) => Promise<unknown>;
  invokeResolveLocal: (url: string) => Promise<{ match: { projectId: number; relPath: string } | null }>;
  openInIde: (projectId: number, relPath: string) => void;
}

export async function openSafeHyperlink(url: string, router: HyperlinkRouter): Promise<boolean> {
  const isLocal = url.startsWith('file://') || url.startsWith('/');
  if (isLocal) {
    try {
      const res = await router.invokeResolveLocal(url);
      if (res.match) {
        router.openInIde(res.match.projectId, res.match.relPath);
        return true;
      }
    } catch (err) {
      console.error('[hyperlink] local resolve failed', err);
    }
  }
  if (!SAFE_SCHEME.test(url)) return false;
  void router.invokeOpenExternal(url).catch((err) => console.error('[hyperlink] open failed', err));
  return true;
}
