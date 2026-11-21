/**
 * OSC-8 hyperlink dispatch for the shell terminal. xterm.js recognises the
 * ESC ] 8 ; ; URL BEL … ESC ] 8 ; ; BEL sequence and renders its payload
 * as styled text, but clicks go nowhere unless the Terminal is given a
 * `linkHandler`. This one passes the URL through to `app:open-external`,
 * which enforces its own scheme allowlist; the local guard here keeps
 * `javascript:` and other unsafe schemes from even reaching IPC.
 */
const SAFE_SCHEME = /^(https?|mailto|file):/i;

export function openSafeHyperlink(
  url: string,
  invoke: (url: string) => Promise<unknown>,
): boolean {
  if (!SAFE_SCHEME.test(url)) return false;
  void invoke(url).catch((err) => console.error('[hyperlink] open failed', err));
  return true;
}
