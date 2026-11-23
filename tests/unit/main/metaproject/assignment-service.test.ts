import { expect, it } from 'vitest';
import { classifyAssignment } from '@main/metaproject/assignment-service';
import { parseMetaprojectOrigin, remoteProjectId } from '@shared/metaproject-contract';

it('never treats an equal numeric ID at another origin as the same assignment', () => {
  const oldOrigin = parseMetaprojectOrigin('https://old.test', false);
  const current = parseMetaprojectOrigin('https://new.test', false);
  if (!oldOrigin || !current) throw new Error('invalid fixture');
  const id = remoteProjectId.parse(8);
  expect(classifyAssignment(id, oldOrigin, current)).toEqual({ kind: 'origin-mismatch', remoteId: 8, origin: oldOrigin });
  expect(classifyAssignment(id, null, current)).toEqual({ kind: 'unconfirmed', remoteId: 8 });
});
