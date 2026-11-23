import { describe, it, expect } from 'vitest';
import { editMetaprojectAssignment, parseAssignmentDocument, parseMetaproject, parseRemoteProjectId } from '@shared/parse-metaproject';
import { remoteProjectId } from '@shared/metaproject-contract';

it('canonicalizes decimal and legacy prefixed IDs only', () => {
  expect(['42', 'PROJ-42'].map(parseRemoteProjectId)).toEqual([42, 42]);
  expect(['0', '1e3', '0x1f', '5.5', '-1', 'ABC-9007199254740992'].map(parseRemoteProjectId)).toEqual(Array(6).fill(null));
});

it('edits root assignment values while preserving comments, CRLF and nested data', () => {
  const original = 'name: Folder\r\nproject_id: "PROJ-42"  # stable\r\nnested:\r\n  project_id: 99\r\nboard_url: https://else.test/a\r\n';
  const doc = parseAssignmentDocument(original);
  if (!doc) throw new Error('unsupported fixture');
  expect(editMetaprojectAssignment(doc, { id: remoteProjectId.parse(71), origin: 'https://example.test' }))
    .toBe('name: Folder\r\nproject_id: "71"  # stable\r\nnested:\r\n  project_id: 99\r\nboard_url: https://else.test/a\r\nmetaproject_origin: https://example.test\r\n');
  expect(editMetaprojectAssignment(doc, null)).toBe('name: Folder\r\n# stable\r\nnested:\r\n  project_id: 99\r\nboard_url: https://else.test/a\r\n');
});

it.each(['project_id: 1\nProject_Id: 2', '"project_id": 12', 'project_id: &anchor 12', '<<: *mapping'])('rejects ambiguous YAML: %s', text => {
  expect(parseAssignmentDocument(text)).toBeNull();
});

it.each([
  'other: [not, closed', 'other: {nested: [incomplete}', 'other: "unclosed',
  'other: |-\n  a\n  b', 'other: one\n  nested: bad', 'other:\n  nested: [bad',
  'other:\n  nested: good\n   invalid: indentation', 'other:\n  duplicate: yes\n  duplicate: no',
  'other: first: second', 'other:\n  child: 1\n child: 2',
])('fails closed on unrelated syntax that cannot be verified: %s', text => {
  expect(parseAssignmentDocument(text)).toBeNull();
});

it('preserves a well-formed nested mapping and quoted unrelated values', () => {
  const text = '\uFEFF# local configuration\nmeta:\n  label: "semi: quoted" # note\n  details:\n    name: Dave\'s team\n  board_url: https://example.test/foo#section\n';
  const doc = parseAssignmentDocument(text);
  if (!doc) throw new Error('invalid fixture');
  expect(editMetaprojectAssignment(doc, null)).toBe(text);
});

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
