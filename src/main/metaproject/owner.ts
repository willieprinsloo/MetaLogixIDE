import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

export function isMetaprojectRendererEntry(rawUrl: string, expectedEntry: string): boolean {
  const expected = URL.parse(expectedEntry);
  const actual = URL.parse(rawUrl);
  if (!expected || !actual || actual.username || actual.password) return false;
  return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname;
}

export function metaprojectOwner(
  event: IpcMainInvokeEvent,
  window: BrowserWindow | null,
  expectedEntry: string,
): BrowserWindow | null {
  if (window === null || window.isDestroyed() || event.sender !== window.webContents) return null;
  const frame = event.senderFrame;
  if (event.sender.isDestroyed() || frame === null || frame !== event.sender.mainFrame) return null;
  return isMetaprojectRendererEntry(frame.url, expectedEntry) ? window : null;
}
