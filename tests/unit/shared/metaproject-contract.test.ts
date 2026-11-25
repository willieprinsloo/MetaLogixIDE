import { describe, expect, it } from 'vitest';
import { metaprojectRequests, parseMetaprojectOrigin } from '@shared/metaproject-contract';
import { isMetaprojectRendererEntry, metaprojectOwner } from '@main/metaproject/owner';

describe('Metaproject trust boundaries', () => {
  it('normalizes a bare host and default port, but retains a different effective port', () => {
    expect(parseMetaprojectOrigin('  Projects.Example:443/ ', false)).toBe('https://projects.example');
    expect(parseMetaprojectOrigin('https://projects.example:444', false)).toBe('https://projects.example:444');
  });

  it.each(['http://localhost', 'http://127.1', 'http://0x7f000001', 'https://example.com/path',
    'https://example.com/?', 'https://example.com/#', 'https://@example.com', 'ftp://example.com',
    'https://example.com\\board', 'https://example.com:', 'https:///example.com'])(
    'rejects unsupported origin %s even with fixture mode enabled', (input) => {
      expect(parseMetaprojectOrigin(input, true)).toBeNull();
    },
  );

  it('requires fixture mode and a literal loopback IP for HTTP', () => {
    expect(parseMetaprojectOrigin('http://127.0.0.1:8080', false)).toBeNull();
    expect(parseMetaprojectOrigin('http://127.0.0.1:8080', true)).toBe('http://127.0.0.1:8080');
    expect(parseMetaprojectOrigin('http://[::1]:8080', true)).toBe('http://[::1]:8080');
  });

  it('validates assignment IDs without accepting renderer paths or remote URLs', () => {
    const save = metaprojectRequests['metaproject:assignment-save'];
    const request = { projectId: 1, remoteId: 2, epoch: 1, revision: '0'.repeat(64), operationId: 'd69f61c5-3efe-43dc-bd49-0f9b553497cd' };
    expect(save.safeParse(request).success).toBe(true);
    expect(save.safeParse({ ...request, remoteId: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(save.safeParse({ ...request, remoteId: '2' }).success).toBe(false);
    expect(save.safeParse({ ...request, path: '/some/project' }).success).toBe(false);
    expect(save.safeParse({ ...request, url: 'https://example.com' }).success).toBe(false);
  });

  it('distinguishes the exact IDE entry from neighboring documents and origins', () => {
    const dev = 'http://localhost:5173/';
    const installed = 'file:///App/out/renderer/index.html';
    expect(isMetaprojectRendererEntry(`${dev}?platform=darwin`, dev)).toBe(true);
    expect(isMetaprojectRendererEntry('http://localhost:5173/elsewhere', dev)).toBe(false);
    expect(isMetaprojectRendererEntry('http://localhost:5174/', dev)).toBe(false);
    expect(isMetaprojectRendererEntry(installed, installed)).toBe(true);
    expect(isMetaprojectRendererEntry('file:///Other/out/renderer/index.html', installed)).toBe(false);
  });

  it('requires the live owner and its exact main frame, not a second window or same-URL subframe', () => {
    const entry = 'file:///App/out/renderer/index.html';
    const mainFrame = { url: `${entry}?platform=darwin` };
    const renderer = { mainFrame, isDestroyed: () => false };
    const owner = { webContents: renderer, isDestroyed: () => false };
    const invocation = { sender: renderer, senderFrame: mainFrame };
    expect(metaprojectOwner(invocation, owner, entry)).toBe(owner);
    expect(metaprojectOwner(invocation, null, entry)).toBeNull();
    expect(metaprojectOwner(invocation, { ...owner, isDestroyed: () => true }, entry)).toBeNull();
    expect(metaprojectOwner({ ...invocation, sender: { ...renderer } }, owner, entry)).toBeNull();
    expect(metaprojectOwner({ ...invocation, senderFrame: { ...mainFrame } }, owner, entry)).toBeNull();
    expect(metaprojectOwner({ ...invocation, senderFrame: null }, owner, entry)).toBeNull();
    expect(metaprojectOwner(invocation, owner, 'file:///Other/out/renderer/index.html')).toBeNull();
    const closedRenderer = { ...renderer, isDestroyed: () => true };
    expect(metaprojectOwner({ ...invocation, sender: closedRenderer }, { ...owner, webContents: closedRenderer }, entry)).toBeNull();
  });
});
