import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

// The app's native modules are built once, for Electron's ABI. The unit
// suite must run on that same runtime, or they fail to load.
describe('unit test runtime', () => {
  it("runs on Electron's embedded Node", () => {
    expect(process.versions.electron).toMatch(/^\d+\./);
  });

  it('loads better-sqlite3 built for this runtime', () => {
    const db = new Database(':memory:');
    expect(db.prepare('select 1 as one').get()).toEqual({ one: 1 });
    db.close();
  });
});
