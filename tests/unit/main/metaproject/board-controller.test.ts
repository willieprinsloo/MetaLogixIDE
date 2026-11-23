import { expect, it } from 'vitest';
import { clampBoardBounds, safeExternalCandidate } from '@main/metaproject/board-controller';

it('clips bounds to content DIPs', () => {
  expect(clampBoardBounds({ x: -10, y: 75, width: 55, height: 100 }, { width: 120, height: 130 })).toEqual({ x: 0, y: 75, width: 45, height: 55 });
});

it('keeps off-site launch candidates credential-free and drops URL parameters', () => {
  expect(safeExternalCandidate('https://other.test/guide?token=private#private')).toBe('https://other.test/guide');
  expect(safeExternalCandidate('https://a:b@other.test/')).toBeNull();
  expect(safeExternalCandidate('file:///private/file')).toBeNull();
});
