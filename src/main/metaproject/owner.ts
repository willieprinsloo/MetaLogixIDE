type FrameIdentity = { readonly url: string };
type RendererContents = { readonly mainFrame: FrameIdentity; isDestroyed(): boolean };
type OwnerWindow = { readonly webContents: RendererContents; isDestroyed(): boolean };
type Invocation = { readonly sender: RendererContents; readonly senderFrame: FrameIdentity | null };

export function isMetaprojectRendererEntry(rawUrl: string, expectedEntry: string): boolean {
  const expected = URL.parse(expectedEntry);
  const actual = URL.parse(rawUrl);
  if (!expected || !actual || actual.username || actual.password) return false;
  return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname;
}

export function metaprojectOwner<W extends OwnerWindow>(
  event: Invocation,
  window: W | null,
  expectedEntry: string,
): W | null {
  if (window === null || window.isDestroyed() || event.sender !== window.webContents) return null;
  const frame = event.senderFrame;
  if (event.sender.isDestroyed() || frame === null || frame !== event.sender.mainFrame) return null;
  return isMetaprojectRendererEntry(frame.url, expectedEntry) ? window : null;
}
