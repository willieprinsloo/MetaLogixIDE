import { describe, expect, it } from 'vitest';
import { filenameTimestamp, storyDir, storyFile } from '@main/story/paths';
import { STORY_DIR } from '@shared/story';

describe('story paths', () => {
  it('nests the story dir inside .metaide/', () => {
    expect(storyDir('/tmp/proj')).toBe(`/tmp/proj/${STORY_DIR}`);
  });

  it('joins filenames into the story dir', () => {
    expect(storyFile('/tmp/proj', 'foo.html')).toBe(`/tmp/proj/${STORY_DIR}/foo.html`);
  });

  it('turns an ISO timestamp into a filesystem-safe prefix including milliseconds', () => {
    expect(filenameTimestamp('2026-11-24T14:30:00.123Z')).toBe('2026-11-24T14-30-00-123');
  });

  it('produces different prefixes for same-second timestamps', () => {
    // Prevents the "double Catch-me-up click clobbers the first chunk" bug.
    expect(filenameTimestamp('2026-01-02T03:04:05.100Z'))
      .not.toBe(filenameTimestamp('2026-01-02T03:04:05.900Z'));
  });
});
