import { describe, it, expect } from 'vitest';
import { parseMetaproject } from '@shared/parse-metaproject';

describe('parseMetaproject', () => {
  it('reads project_id and board_url', () => {
    const out = parseMetaproject('project_id: PROJ-42\nboard_url: https://metaproject.internal\n');
    expect(out).toEqual({ projectId: 'PROJ-42', boardUrl: 'https://metaproject.internal' });
  });

  it('tolerates quoted values, comments, blank lines', () => {
    const text = `
      # linked to the meta project board
      project_id: "PROJ-42"   # our stable id
      board_url:  'https://metaproject.local'

      # trailing junk
      unrelated: nope
    `;
    expect(parseMetaproject(text)).toEqual({
      projectId: 'PROJ-42',
      boardUrl: 'https://metaproject.local',
    });
  });

  it('returns null fields when the file is empty or unrelated', () => {
    expect(parseMetaproject('')).toEqual({ projectId: null, boardUrl: null });
    expect(parseMetaproject('name: foo\ndescription: bar\n')).toEqual({ projectId: null, boardUrl: null });
  });

  it('is case-insensitive on keys but preserves the value verbatim', () => {
    const out = parseMetaproject('Project_Id: A-B_c\nBoard_URL: https://X/y\n');
    expect(out).toEqual({ projectId: 'A-B_c', boardUrl: 'https://X/y' });
  });
});
