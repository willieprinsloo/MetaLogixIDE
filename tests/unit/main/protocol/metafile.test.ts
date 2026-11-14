/** metafile:// URL resolution: project-root containment for the sandboxed HTML preview protocol. */
import { describe, expect, it } from 'vitest';
import { METAFILE_SCHEME, resolveMetafileUrl } from '@main/protocol/metafile';

const roots = new Map<number, string>([[1, '/work/project-a'], [2, '/work/project-b']]);
const getProjectPath = (id: number): string | null => roots.get(id) ?? null;

describe('resolveMetafileUrl', () => {
  it('resolves a project file inside its root', () => {
    const hit = resolveMetafileUrl('metafile://p/1/src/index.html', getProjectPath);
    expect(hit?.abs).toBe('/work/project-a/src/index.html');
  });

  it('rejects path traversal out of the root', () => {
    expect(resolveMetafileUrl('metafile://p/1/../../etc/passwd', getProjectPath)).toBeNull();
  });

  it('rejects URL-encoded dot segments too', () => {
    expect(resolveMetafileUrl('metafile://p/1/%2e%2e/%2e%2e/etc/passwd', getProjectPath)).toBeNull();
    expect(resolveMetafileUrl('metafile://p/1/docs/%2E%2E/%2E%2E/etc/passwd', getProjectPath)).toBeNull();
  });

  it('rejects unknown projects', () => {
    expect(resolveMetafileUrl('metafile://p/999/x.html', getProjectPath)).toBeNull();
  });

  it('rejects an empty pathname', () => {
    expect(resolveMetafileUrl('metafile://p/1', getProjectPath)).toBeNull();
  });

  it('decodes URL-encoded segments', () => {
    const hit = resolveMetafileUrl('metafile://p/1/docs/my%20report.html', getProjectPath);
    expect(hit?.abs).toBe('/work/project-a/docs/my report.html');
  });

  it('strips query strings and fragments from the path', () => {
    expect(resolveMetafileUrl('metafile://p/1/styles.css?v=3', getProjectPath)?.abs)
      .toBe('/work/project-a/styles.css');
    expect(resolveMetafileUrl('metafile://p/1/docs/index.html#section', getProjectPath)?.abs)
      .toBe('/work/project-a/docs/index.html');
  });

  it('exposes the scheme name', () => {
    expect(METAFILE_SCHEME).toBe('metafile');
  });
});
