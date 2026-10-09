import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IpcMain } from 'electron';
import { registerIpc } from '@main/ipc/register';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { SettingsRepo } from '@main/repos/settings-repo';
import { ViewedShells } from '@main/notifications/viewed-shells';
import { RootsRepo } from '@main/repos/roots-repo';
import { ProjectsRepo } from '@main/repos/projects-repo';
import { ShellsRepo } from '@main/repos/shells-repo';
import { applyClaudePermissionMode } from '@main/domain/claude-permission-mode';
import type { ProjectConfig } from '@shared/types';
import type { ResolvedLaunch } from '@main/domain/launch';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { commitAll, git, makeConflict, markerScript, stubGitEnv, tempProject } from '../git/temp-repo';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const migrationsDir = resolve(__dirname, '../../../../migrations');

function fakeIpcMain(): IpcMain & { handlers: Map<string, (e: unknown, req: unknown) => Promise<unknown>> } {
  const handlers = new Map<string, (e: unknown, req: unknown) => Promise<unknown>>();
  return {
    handle: (channel: string, fn: (e: unknown, req: unknown) => Promise<unknown>) => handlers.set(channel, fn),
    handlers,
  } as unknown as ReturnType<typeof fakeIpcMain>;
}

/** Real SettingsRepo backed by a temp sqlite db, seeded with defaults, for tests that exercise the real permission-mode rewrite. */
function realSettings(): SettingsRepo {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'reg-')), 'db'));
  runMigrations(db, migrationsDir);
  const repo = new SettingsRepo(db);
  repo.seedDefaults();
  return repo;
}

/** Minimal ptyManager stand-in: every method is a spy, so a test can assert nothing was spawned. */
function fakePtyManager() {
  return { on: vi.fn(), off: vi.fn(), spawn: vi.fn(async () => {}), kill: vi.fn(async () => {}), isAlive: vi.fn(() => false), resize: vi.fn(), write: vi.fn(), getScrollback: vi.fn(() => ''), getSnapshot: vi.fn(async () => ''), allPorts: vi.fn(() => []), liveShells: vi.fn(() => []) };
}

describe('registerIpc', () => {
  it('registers every declared channel', async () => {
    const ipc = fakeIpcMain();
    const services = {} as unknown as Parameters<typeof registerIpc>[1]; // handlers are not invoked in this test
    registerIpc(ipc as unknown as IpcMain, services, () => {});
    const expected = [
      'roots:list', 'roots:add', 'roots:remove', 'roots:rescan',
      'projects:list', 'projects:open', 'projects:pin', 'projects:hide',
      'projects:update-config', 'projects:recents',
      'shells:launch', 'shells:kill', 'shells:resize', 'shells:write',
      'shells:alive-list', 'shells:pin',
      'settings:get', 'settings:set', 'settings:set-font', 'settings:set-app-env', 'settings:set-claude-permission-mode',
      'files:tree', 'app:ping', 'notifications:viewed-shells', 'claude-state:list',
    ];
    for (const c of expected) expect(ipc.handlers.has(c)).toBe(true);
  });

  it('claude-state:list returns the tracker list as { shells }', async () => {
    const ipc = fakeIpcMain();
    const shells = [{ projectId: 1, shellIndex: 0, state: 'busy' }, { projectId: 2, shellIndex: 3, state: 'blocked' }];
    const list = vi.fn(() => shells);
    const services = { claudeState: { list } } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, () => {});
    await expect(ipc.handlers.get('claude-state:list')!({}, undefined)).resolves.toEqual({ shells });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('settings:set rejects key claude_permission_mode without writing', async () => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    const setSpy = vi.spyOn(settings, 'set');
    const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, () => {});
    const handler = ipc.handlers.get('settings:set')!;
    await expect(handler({}, { key: 'claude_permission_mode', value: 'auto' })).rejects.toThrow();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it.each(['ui_font_family', 'terminal_font_family'] as const)('settings:set rejects font key %s without writing', async (key) => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    const setSpy = vi.spyOn(settings, 'set');
    const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, () => {});

    await expect(ipc.handlers.get('settings:set')!({}, { key, value: 'Bypass Font' })).rejects.toThrow();
    expect(setSpy).not.toHaveBeenCalled();
    expect(settings.get(key)).toBeNull();
  });

  it('settings:set rejects key app_env without writing (bypass of settings:set-app-env, AC4)', async () => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    const setSpy = vi.spyOn(settings, 'set');
    const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, () => {});

    await expect(
      ipc.handlers.get('settings:set')!({}, { key: 'app_env', value: { X: '1' } }),
    ).rejects.toThrow();
    expect(setSpy).not.toHaveBeenCalled();
    expect(settings.get('app_env')).toEqual({});
  });

  describe('settings:set-app-env (AC4, AC6)', () => {
    it('a valid save replaces the whole map, returns { env }, and emits exactly one keyed settings:changed', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      settings.set('app_env', { OLD: '1' });
      const events: Array<{ channel: string; payload: unknown }> = [];
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, ((channel: string, payload: unknown) => {
        events.push({ channel, payload });
      }) as never);

      await expect(
        ipc.handlers.get('settings:set-app-env')!({}, { env: { NEW: '1' } }),
      ).resolves.toEqual({ env: { NEW: '1' } });
      expect(settings.get('app_env')).toEqual({ NEW: '1' });
      expect(events).toEqual([{ channel: 'settings:changed', payload: { key: 'app_env' } }]);
    });

    it('an empty map clears the stored app env', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      settings.set('app_env', { OLD: '1' });
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, () => {});

      await expect(ipc.handlers.get('settings:set-app-env')!({}, { env: {} })).resolves.toEqual({
        env: {},
      });
      expect(settings.get('app_env')).toEqual({});
    });

    it.each([
      ['invalid name', { 'MY-VAR': 'x' }],
      ['reserved name', { METAIDE_HOOK_TOKEN: 'x' }],
      ['reserved __proto__ name', JSON.parse('{"__proto__": "x"}') as unknown],
      ['NUL value', { TOKEN: 'S3CRET\0' }],
      ['non-object request', 'not-a-map'],
      ['non-string value', { TOKEN: { nested: 'S3CRET' } }],
    ])('rejects %s, writes nothing, and emits nothing', async (_label, env) => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      settings.set('app_env', { KEEP: '1' });
      const setSpy = vi.spyOn(settings, 'set');
      const events: Array<{ channel: string; payload: unknown }> = [];
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, ((channel: string, payload: unknown) => {
        events.push({ channel, payload });
      }) as never);

      await expect(ipc.handlers.get('settings:set-app-env')!({}, { env })).rejects.toThrow();
      expect(setSpy).not.toHaveBeenCalled();
      expect(settings.get('app_env')).toEqual({ KEEP: '1' });
      expect(events).toEqual([]);
    });

    it('rejects a custom-prototype map and names the key, never the value', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, () => {});
      const env = Object.create({ A: 'x' }) as Record<string, string>;
      env.TOKEN = 'S3CRET';

      await expect(ipc.handlers.get('settings:set-app-env')!({}, { env })).rejects.toThrow();
      expect(settings.get('app_env')).toEqual({});
    });

    it('the error names the offending key and never contains the value', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, () => {});

      await expect(
        ipc.handlers.get('settings:set-app-env')!({}, { env: { TOKEN: 'S3CRET\0' } }),
      ).rejects.toThrow(/TOKEN/);
      try {
        await ipc.handlers.get('settings:set-app-env')!({}, { env: { TOKEN: 'S3CRET\0' } });
      } catch (e) {
        expect((e as Error).message).not.toContain('S3CRET');
      }
    });
  });

  it('settings:set-font normalizes, persists, returns, then emits one keyed change event', async () => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    const events: Array<{ channel: string; payload: unknown; stored: unknown }> = [];
    const sendEvent = (channel: string, payload: unknown) => {
      events.push({ channel, payload, stored: settings.get('ui_font_family') });
    };
    const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, sendEvent as never);

    await expect(ipc.handlers.get('settings:set-font')!({}, {
      key: 'ui_font_family',
      value: '  字體 “Quoted”, Semi; Slash\\  ',
    })).resolves.toEqual({ value: '字體 “Quoted”, Semi; Slash\\' });
    expect(settings.get('ui_font_family')).toBe('字體 “Quoted”, Semi; Slash\\');
    expect(settings.get('terminal_font_family')).toBeNull();
    expect(events).toEqual([{
      channel: 'settings:changed',
      payload: { key: 'ui_font_family' },
      stored: '字體 “Quoted”, Semi; Slash\\',
    }]);
  });

  it('settings:set-font resets only the requested preference to null', async () => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    settings.set('ui_font_family', 'UI Font');
    settings.set('terminal_font_family', 'Terminal Font');
    const events: Array<{ channel: string; payload: unknown }> = [];
    const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, ((channel: string, payload: unknown) => {
      events.push({ channel, payload });
    }) as never);

    await expect(ipc.handlers.get('settings:set-font')!({}, {
      key: 'terminal_font_family',
      value: null,
    })).resolves.toEqual({ value: null });
    expect(settings.get('ui_font_family')).toBe('UI Font');
    expect(settings.get('terminal_font_family')).toBeNull();
    expect(events).toEqual([{
      channel: 'settings:changed',
      payload: { key: 'terminal_font_family' },
    }]);
  });

  it.each([
    ['invalid key', { key: 'theme', value: 'Font' }],
    ['numeric key', { key: 42, value: 'Font' }],
    ['undefined value', { key: 'ui_font_family', value: undefined }],
    ['object value', { key: 'ui_font_family', value: { family: 'Font' } }],
    ['empty value', { key: 'ui_font_family', value: '   ' }],
    ['NUL value', { key: 'ui_font_family', value: 'Bad\u0000Font' }],
    ['C0 value', { key: 'ui_font_family', value: 'Bad\nFont' }],
    ['overlength value', { key: 'ui_font_family', value: '😀'.repeat(257) }],
  ])('settings:set-font rejects %s without state change or event', async (_case, request) => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    settings.set('ui_font_family', 'Existing Font');
    const events: Array<{ channel: string; payload: unknown }> = [];
    const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, ((channel: string, payload: unknown) => {
      events.push({ channel, payload });
    }) as never);

    await expect(ipc.handlers.get('settings:set-font')!({}, request)).rejects.toThrow();
    expect(settings.get('ui_font_family')).toBe('Existing Font');
    expect(settings.get('terminal_font_family')).toBeNull();
    expect(events).toEqual([]);
  });

  it('settings:set-font leaves state unchanged and emits nothing when persistence fails', async () => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    settings.set('ui_font_family', 'Existing Font');
    const setSpy = vi.spyOn(settings, 'set').mockImplementation(() => {
      throw new Error('write failed');
    });
    const events: Array<{ channel: string; payload: unknown }> = [];
    const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, ((channel: string, payload: unknown) => {
      events.push({ channel, payload });
    }) as never);

    await expect(ipc.handlers.get('settings:set-font')!({}, {
      key: 'ui_font_family',
      value: 'Valid Font',
    })).rejects.toThrow('write failed');
    expect(setSpy).toHaveBeenCalledWith('ui_font_family', 'Valid Font');
    expect(settings.get('ui_font_family')).toBe('Existing Font');
    expect(settings.get('terminal_font_family')).toBeNull();
    expect(events).toEqual([]);
  });

  describe('settings:set-terminal-font-size (AC9, AC10)', () => {
    it('settings:set rejects key terminal_font_size without writing (bypass guard)', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      const setSpy = vi.spyOn(settings, 'set');
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, () => {});

      await expect(
        ipc.handlers.get('settings:set')!({}, { key: 'terminal_font_size', value: 16 }),
      ).rejects.toThrow();
      expect(setSpy).not.toHaveBeenCalled();
      expect(settings.get('terminal_font_size')).toBeNull();
    });

    it.each([8, 29, 16.5, '16', null])('rejects invalid value %j, leaves the store untouched, emits nothing', async (value) => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      const setSpy = vi.spyOn(settings, 'set');
      const events: Array<{ channel: string; payload: unknown }> = [];
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, ((channel: string, payload: unknown) => {
        events.push({ channel, payload });
      }) as never);

      await expect(
        ipc.handlers.get('settings:set-terminal-font-size')!({}, { value }),
      ).rejects.toThrow();
      expect(setSpy).not.toHaveBeenCalled();
      expect(settings.get('terminal_font_size')).toBeNull();
      expect(events).toEqual([]);
    });

    it('a valid value writes, returns { value, changed: true }, and emits exactly one keyed settings:changed', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      const events: Array<{ channel: string; payload: unknown }> = [];
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, ((channel: string, payload: unknown) => {
        events.push({ channel, payload });
      }) as never);

      await expect(
        ipc.handlers.get('settings:set-terminal-font-size')!({}, { value: 16 }),
      ).resolves.toEqual({ value: 16, changed: true });
      expect(settings.get('terminal_font_size')).toBe(16);
      expect(events).toEqual([{ channel: 'settings:changed', payload: { key: 'terminal_font_size' } }]);
    });

    it('onlyIfUnset with a null stored value writes and emits once', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      const events: Array<{ channel: string; payload: unknown }> = [];
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, ((channel: string, payload: unknown) => {
        events.push({ channel, payload });
      }) as never);

      await expect(
        ipc.handlers.get('settings:set-terminal-font-size')!({}, { value: 18, onlyIfUnset: true }),
      ).resolves.toEqual({ value: 18, changed: true });
      expect(settings.get('terminal_font_size')).toBe(18);
      expect(events).toEqual([{ channel: 'settings:changed', payload: { key: 'terminal_font_size' } }]);
    });

    it('onlyIfUnset with an already-saved value does not write, returns changed: false, and emits nothing', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      settings.set('terminal_font_size', 20);
      const setSpy = vi.spyOn(settings, 'set');
      const events: Array<{ channel: string; payload: unknown }> = [];
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, ((channel: string, payload: unknown) => {
        events.push({ channel, payload });
      }) as never);

      await expect(
        ipc.handlers.get('settings:set-terminal-font-size')!({}, { value: 18, onlyIfUnset: true }),
      ).resolves.toEqual({ value: 20, changed: false });
      expect(setSpy).not.toHaveBeenCalled();
      expect(settings.get('terminal_font_size')).toBe(20);
      expect(events).toEqual([]);
    });

    it('settings:get on a fresh DB returns null for the key', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, () => {});

      await expect(
        ipc.handlers.get('settings:get')!({}, { key: 'terminal_font_size' }),
      ).resolves.toEqual({ value: null });
    });
  });

  describe('settings:set-terminal-font-weight (AC4, AC8, AC11)', () => {
    it('settings:set rejects key terminal_font_weight without writing (bypass guard)', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      const setSpy = vi.spyOn(settings, 'set');
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, () => {});

      await expect(
        ipc.handlers.get('settings:set')!({}, { key: 'terminal_font_weight', value: 500 }),
      ).rejects.toThrow();
      expect(setSpy).not.toHaveBeenCalled();
      expect(settings.get('terminal_font_weight')).toBeNull();
    });

    it('settings:set rejects key terminal_bold_weight without writing (bypass guard)', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      const setSpy = vi.spyOn(settings, 'set');
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, () => {});

      await expect(
        ipc.handlers.get('settings:set')!({}, { key: 'terminal_bold_weight', value: 700 }),
      ).rejects.toThrow();
      expect(setSpy).not.toHaveBeenCalled();
      expect(settings.get('terminal_bold_weight')).toBeNull();
    });

    it.each([450, 1000, 0, 'bold', null])('rejects invalid value %j, leaves both keys untouched, emits nothing', async (value) => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      const setSpy = vi.spyOn(settings, 'set');
      const setManySpy = vi.spyOn(settings, 'setMany');
      const events: Array<{ channel: string; payload: unknown }> = [];
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, ((channel: string, payload: unknown) => {
        events.push({ channel, payload });
      }) as never);

      await expect(
        ipc.handlers.get('settings:set-terminal-font-weight')!({}, { value }),
      ).rejects.toThrow();
      expect(setSpy).not.toHaveBeenCalled();
      expect(setManySpy).not.toHaveBeenCalled();
      expect(settings.get('terminal_font_weight')).toBeNull();
      expect(settings.get('terminal_bold_weight')).toBeNull();
      expect(events).toEqual([]);
    });

    it('a valid value writes {weight, derivedBoldWeight} through one setMany call and returns {weight, boldWeight, changedKeys}', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      const setManySpy = vi.spyOn(settings, 'setMany');
      const events: Array<{ channel: string; payload: unknown }> = [];
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, ((channel: string, payload: unknown) => {
        events.push({ channel, payload });
      }) as never);

      await expect(
        ipc.handlers.get('settings:set-terminal-font-weight')!({}, { value: 500 }),
      ).resolves.toEqual({ weight: 500, boldWeight: 700, changedKeys: expect.arrayContaining(['terminal_font_weight', 'terminal_bold_weight']) });
      expect(settings.get('terminal_font_weight')).toBe(500);
      expect(settings.get('terminal_bold_weight')).toBe(700);
      expect(setManySpy).toHaveBeenCalledTimes(1);
      const settingsChangedKeys = events.filter(e => e.channel === 'settings:changed').map(e => (e.payload as { key: string }).key);
      expect(new Set(settingsChangedKeys)).toEqual(new Set(['terminal_font_weight', 'terminal_bold_weight']));
    });

    it.each([
      [100, 300],
      [400, 600],
      [800, 900],
    ] as const)('choosing W %i stores bold %i (min(W + 200, 900), no 700 floor)', async (weight, bold) => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, () => {});

      await expect(
        ipc.handlers.get('settings:set-terminal-font-weight')!({}, { value: weight }),
      ).resolves.toMatchObject({ weight, boldWeight: bold });
      expect(settings.get('terminal_bold_weight')).toBe(bold);
    });

    it('resets a hand-set bold weight (W 400, B 900, then choosing W 500 resets B to 700)', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      settings.setMany({ terminal_font_weight: 400, terminal_bold_weight: 900 });
      const events: Array<{ channel: string; payload: unknown }> = [];
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, ((channel: string, payload: unknown) => {
        events.push({ channel, payload });
      }) as never);

      await expect(
        ipc.handlers.get('settings:set-terminal-font-weight')!({}, { value: 500 }),
      ).resolves.toEqual({ weight: 500, boldWeight: 700, changedKeys: expect.arrayContaining(['terminal_font_weight', 'terminal_bold_weight']) });
      expect(settings.get('terminal_font_weight')).toBe(500);
      expect(settings.get('terminal_bold_weight')).toBe(700);
    });

    it('atomicity: when setMany throws, the handler rejects and neither stored value changes', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      settings.setMany({ terminal_font_weight: 400, terminal_bold_weight: 700 });
      vi.spyOn(settings, 'setMany').mockImplementation(() => { throw new Error('write failed'); });
      const events: Array<{ channel: string; payload: unknown }> = [];
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, ((channel: string, payload: unknown) => {
        events.push({ channel, payload });
      }) as never);

      await expect(
        ipc.handlers.get('settings:set-terminal-font-weight')!({}, { value: 500 }),
      ).rejects.toThrow();
      expect(settings.get('terminal_font_weight')).toBe(400);
      expect(settings.get('terminal_bold_weight')).toBe(700);
      expect(events).toEqual([]);
    });

    it('no-op: when both stored values already equal the target pair, changedKeys is empty, nothing is written, nothing is emitted', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      settings.setMany({ terminal_font_weight: 500, terminal_bold_weight: 700 });
      const setManySpy = vi.spyOn(settings, 'setMany');
      const events: Array<{ channel: string; payload: unknown }> = [];
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, ((channel: string, payload: unknown) => {
        events.push({ channel, payload });
      }) as never);

      await expect(
        ipc.handlers.get('settings:set-terminal-font-weight')!({}, { value: 500 }),
      ).resolves.toEqual({ weight: 500, boldWeight: 700, changedKeys: [] });
      expect(setManySpy).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    });

    it('no-op on weight alone: when only the bold weight differs, changedKeys lists only terminal_bold_weight and emits once', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      settings.setMany({ terminal_font_weight: 500, terminal_bold_weight: 600 });
      const events: Array<{ channel: string; payload: unknown }> = [];
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, ((channel: string, payload: unknown) => {
        events.push({ channel, payload });
      }) as never);

      await expect(
        ipc.handlers.get('settings:set-terminal-font-weight')!({}, { value: 500 }),
      ).resolves.toEqual({ weight: 500, boldWeight: 700, changedKeys: ['terminal_bold_weight'] });
      expect(settings.get('terminal_font_weight')).toBe(500);
      expect(settings.get('terminal_bold_weight')).toBe(700);
      expect(events).toEqual([{ channel: 'settings:changed', payload: { key: 'terminal_bold_weight' } }]);
    });

    it('settings:get on a fresh DB returns null for the key', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, () => {});

      await expect(
        ipc.handlers.get('settings:get')!({}, { key: 'terminal_font_weight' }),
      ).resolves.toEqual({ value: null });
    });
  });

  describe('settings:set-terminal-bold-weight (AC4, AC8, AC11)', () => {
    it('rejects invalid values with nothing changed', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      const setSpy = vi.spyOn(settings, 'set');
      const events: Array<{ channel: string; payload: unknown }> = [];
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, ((channel: string, payload: unknown) => {
        events.push({ channel, payload });
      }) as never);

      await expect(
        ipc.handlers.get('settings:set-terminal-bold-weight')!({}, { value: 450 }),
      ).rejects.toThrow();
      expect(setSpy).not.toHaveBeenCalled();
      expect(settings.get('terminal_bold_weight')).toBeNull();
      expect(events).toEqual([]);
    });

    it('with stored weight 500, rejects B=500 and B=400, accepts B=600 and B=900', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      settings.set('terminal_font_weight', 500);
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, () => {});
      const handler = ipc.handlers.get('settings:set-terminal-bold-weight')!;

      await expect(handler({}, { value: 500 })).rejects.toThrow();
      await expect(handler({}, { value: 400 })).rejects.toThrow();
      expect(settings.get('terminal_bold_weight')).toBeNull();

      await expect(handler({}, { value: 600 })).resolves.toEqual({ value: 600, changed: true });
      expect(settings.get('terminal_bold_weight')).toBe(600);

      await expect(handler({}, { value: 900 })).resolves.toEqual({ value: 900, changed: true });
      expect(settings.get('terminal_bold_weight')).toBe(900);
    });

    it('with stored weight 900, accepts B=900 and rejects B=800', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      settings.set('terminal_font_weight', 900);
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, () => {});
      const handler = ipc.handlers.get('settings:set-terminal-bold-weight')!;

      await expect(handler({}, { value: 800 })).rejects.toThrow();
      expect(settings.get('terminal_bold_weight')).toBeNull();

      await expect(handler({}, { value: 900 })).resolves.toEqual({ value: 900, changed: true });
      expect(settings.get('terminal_bold_weight')).toBe(900);
    });

    it('with stored weight null, validates against 400: rejects B=400, accepts B=500', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, () => {});
      const handler = ipc.handlers.get('settings:set-terminal-bold-weight')!;

      await expect(handler({}, { value: 400 })).rejects.toThrow();
      await expect(handler({}, { value: 500 })).resolves.toEqual({ value: 500, changed: true });
    });

    it('with stored weight 450 (invalid), validates against the in-use weight 400: rejects B=400, accepts B=500', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      settings.set('terminal_font_weight', 450);
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, () => {});
      const handler = ipc.handlers.get('settings:set-terminal-bold-weight')!;

      await expect(handler({}, { value: 400 })).rejects.toThrow();
      await expect(handler({}, { value: 500 })).resolves.toEqual({ value: 500, changed: true });
    });

    it.each([1000, 'bold'])(
      'with stored weight %j (invalid, not a near miss), validates against the in-use weight 400: rejects B=400, accepts B=500',
      async (storedWeight) => {
        const ipc = fakeIpcMain();
        const settings = realSettings();
        settings.set('terminal_font_weight', storedWeight as never);
        const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
        registerIpc(ipc as unknown as IpcMain, services, () => {});
        const handler = ipc.handlers.get('settings:set-terminal-bold-weight')!;

        await expect(handler({}, { value: 400 })).rejects.toThrow();
        await expect(handler({}, { value: 500 })).resolves.toEqual({ value: 500, changed: true });
        expect(settings.get('terminal_font_weight')).toBe(storedWeight);
      },
    );

    it('never touches the stored font weight', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      settings.set('terminal_font_weight', 500);
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, () => {});
      await ipc.handlers.get('settings:set-terminal-bold-weight')!({}, { value: 900 });
      expect(settings.get('terminal_font_weight')).toBe(500);
    });

    it('writing the already-stored bold value returns changed: false with no write and no emit', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      settings.setMany({ terminal_font_weight: 500, terminal_bold_weight: 700 });
      const setSpy = vi.spyOn(settings, 'set');
      const events: Array<{ channel: string; payload: unknown }> = [];
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, ((channel: string, payload: unknown) => {
        events.push({ channel, payload });
      }) as never);

      await expect(
        ipc.handlers.get('settings:set-terminal-bold-weight')!({}, { value: 700 }),
      ).resolves.toEqual({ value: 700, changed: false });
      expect(setSpy).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    });

    it('a change emits settings:changed { key: terminal_bold_weight } exactly once', async () => {
      const ipc = fakeIpcMain();
      const settings = realSettings();
      settings.set('terminal_font_weight', 500);
      const events: Array<{ channel: string; payload: unknown }> = [];
      const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, ((channel: string, payload: unknown) => {
        events.push({ channel, payload });
      }) as never);

      await ipc.handlers.get('settings:set-terminal-bold-weight')!({}, { value: 900 });
      expect(events).toEqual([{ channel: 'settings:changed', payload: { key: 'terminal_bold_weight' } }]);
    });
  });

  it.each(['plan', 'bypassPermissions', '', undefined])('settings:set-claude-permission-mode rejects mode %j without changing anything', async (mode) => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    const before = settings.get('claude_permission_mode');
    const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, () => {});
    const handler = ipc.handlers.get('settings:set-claude-permission-mode')!;
    await expect(handler({}, { mode })).rejects.toThrow();
    expect(settings.get('claude_permission_mode')).toBe(before);
  });

  it('shells:snapshot returns the serialized terminal state, not the raw scrollback tail', async () => {
    const ipc = fakeIpcMain();
    const ptyManager = fakePtyManager();
    ptyManager.isAlive.mockReturnValue(true);
    ptyManager.getScrollback.mockReturnValue('RAW-TAIL');
    ptyManager.getSnapshot.mockResolvedValue('\x1b[1mSERIALIZED');
    const services = { ptyManager } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, () => {});
    const result = await ipc.handlers.get('shells:snapshot')!({}, { projectId: 4, shellIndex: 2 });
    expect(result).toEqual({ output: '\x1b[1mSERIALIZED', alive: true });
    expect(ptyManager.getSnapshot).toHaveBeenCalledWith(4, 2);
  });

  it('shells:snapshot returns an empty dead snapshot when no ptyManager is wired', async () => {
    const ipc = fakeIpcMain();
    registerIpc(ipc as unknown as IpcMain, {} as unknown as Parameters<typeof registerIpc>[1], () => {});
    await expect(ipc.handlers.get('shells:snapshot')!({}, { projectId: 1, shellIndex: 0 })).resolves.toEqual({ output: '', alive: false });
  });

  it('shells:launch rejects while the permission mode is unchosen, without spawning', async () => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    expect(settings.get('claude_permission_mode')).toBeNull();
    const ptyManager = fakePtyManager();
    const services = { settings, ptyManager } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, () => {});
    const handler = ipc.handlers.get('shells:launch')!;
    await expect(handler({}, { projectId: 1 })).rejects.toThrow('Choose a Claude permission mode first');
    expect(ptyManager.spawn).not.toHaveBeenCalled();
  });

  it('settings:set-claude-permission-mode returns { mode, changedKeys } and emits settings:changed once per changed key', async () => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    const events: Array<{ channel: string; payload: unknown }> = [];
    const sendEvent = (channel: string, payload: unknown) => { events.push({ channel, payload }); };
    const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, sendEvent as never);
    const handler = ipc.handlers.get('settings:set-claude-permission-mode')!;
    const result = await handler({}, { mode: 'auto' }) as { mode: string; changedKeys: string[] };
    expect(result.mode).toBe('auto');
    expect(new Set(result.changedKeys)).toEqual(new Set(['claude_permission_mode', 'default_launch_cmd.first', 'default_launch_cmd.subsequent', 'default_cli_profiles']));
    const settingsChangedKeys = events.filter(e => e.channel === 'settings:changed').map(e => (e.payload as { key: string }).key);
    expect(new Set(settingsChangedKeys)).toEqual(new Set(result.changedKeys));
    expect(settingsChangedKeys).toHaveLength(result.changedKeys.length);
  });

  it('settings:set-claude-permission-mode emits nothing on failure', async () => {
    const ipc = fakeIpcMain();
    const settings = realSettings();
    const events: Array<{ channel: string; payload: unknown }> = [];
    const sendEvent = (channel: string, payload: unknown) => { events.push({ channel, payload }); };
    const services = { settings } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, sendEvent as never);
    const handler = ipc.handlers.get('settings:set-claude-permission-mode')!;
    await expect(handler({}, { mode: 'plan' })).rejects.toThrow();
    expect(events).toEqual([]);
  });

  describe('notifications:viewed-shells', () => {
    const main = {};
    const mainFocused = { focused: () => main, main: () => main, popout: () => null };

    function setupViewed() {
      const ipc = fakeIpcMain();
      const viewedShells = new ViewedShells();
      const services = { viewedShells } as unknown as Parameters<typeof registerIpc>[1];
      registerIpc(ipc as unknown as IpcMain, services, () => {});
      return { handler: ipc.handlers.get('notifications:viewed-shells')!, viewedShells };
    }

    it('a valid payload replaces the reported view', async () => {
      const { handler, viewedShells } = setupViewed();
      await expect(handler({}, { shells: [{ projectId: 3, shellIndex: 1 }] })).resolves.toEqual({ ok: true });
      expect(viewedShells.isViewing({ projectId: 3, shellIndex: 1 }, mainFocused)).toBe(true);
      await handler({}, { shells: [] });
      expect(viewedShells.isViewing({ projectId: 3, shellIndex: 1 }, mainFocused)).toBe(false);
    });

    it.each([
      ['more than 8 items', { shells: Array.from({ length: 9 }, (_, i) => ({ projectId: 1, shellIndex: i })) }],
      ['a non-integer id', { shells: [{ projectId: 1.5, shellIndex: 0 }] }],
      ['a negative shell index', { shells: [{ projectId: 1, shellIndex: -1 }] }],
      ['projectId 0', { shells: [{ projectId: 0, shellIndex: 0 }] }],
      ['a non-array', { shells: 'all' }],
    ])('rejects %s and leaves the view unchanged', async (_label, req) => {
      const { handler, viewedShells } = setupViewed();
      await handler({}, { shells: [{ projectId: 3, shellIndex: 1 }] });
      await expect(handler({}, req)).rejects.toThrow(/viewed shells/);
      expect(viewedShells.isViewing({ projectId: 3, shellIndex: 1 }, mainFocused)).toBe(true);
    });
  });
});

/**
 * Real projects/shells/settings repos on a temp db, a spy ptyManager and two
 * projects on disk, for exercising project env at every spawn site.
 */
function envRig() {
  const dir = mkdtempSync(join(tmpdir(), 'reg-env-'));
  const db = openDb(join(dir, 'db'));
  runMigrations(db, migrationsDir);
  const settings = new SettingsRepo(db);
  settings.seedDefaults();
  applyClaudePermissionMode(settings, 'auto');
  const projects = new ProjectsRepo(db);
  const shells = new ShellsRepo(db);
  const root = new RootsRepo(db).add(dir);
  const pathA = join(dir, 'alpha');
  const pathB = join(dir, 'beta');
  mkdirSync(pathA);
  mkdirSync(pathB);
  const a = projects.upsert(root.id, pathA, 'alpha');
  const b = projects.upsert(root.id, pathB, 'beta');
  const ptyManager = fakePtyManager();
  const events: string[] = [];
  const ipc = fakeIpcMain();
  const services = {
    settings,
    projects,
    shells,
    ptyManager,
    homeDir: '/home/u',
  } as unknown as Parameters<typeof registerIpc>[1];
  registerIpc(ipc as unknown as IpcMain, services, ((channel: string) => {
    events.push(channel);
  }) as never);
  const call = (channel: string, req: unknown) => ipc.handlers.get(channel)!({}, req);
  const spawned = (n: number) =>
    (ptyManager.spawn.mock.calls[n] as unknown as [number, number, ResolvedLaunch])[2];
  const setEnv = (id: number, env: Record<string, string>) => projects.updateConfig(id, { env });
  return {
    dir,
    settings,
    projects,
    shells,
    ptyManager,
    events,
    call,
    spawned,
    setEnv,
    a,
    b,
    pathA,
  };
}

describe('projects:update-config — env validation (AC8, AC9)', () => {
  const seeded: ProjectConfig = {
    env: { A: '1' },
    launchCmd: { first: { argv: ['echo'], env: {} } },
    cliProfiles: [{ name: 'p', argv: ['codex'] }],
    defaultCliName: 'p',
  };

  it.each([
    ['an invalid name', { env: { 'MY-VAR': 'x' } }],
    ['a leading-digit name', { env: { '1FOO': 'x' } }],
    ['a reserved name', { env: { METAIDE_HOOK_TOKEN: 'x' } }],
    ['a reserved lower-case name', { env: { metaide_x: 'x' } }],
    ['an own __proto__ name', JSON.parse('{"env":{"__proto__":"x"}}') as unknown],
    ['a non-string value', { env: { A: 1 } }],
    ['a null value', { env: { A: null } }],
    ['a NUL value', { env: { A: 'x\0y' } }],
    ['an array env', { env: [['A', '1']] }],
    ['a null env', { env: null }],
    ['a string env', { env: 'A=1' }],
  ])('rejects %s and leaves the stored config and events unchanged', async (_label, config) => {
    const rig = envRig();
    rig.projects.updateConfig(rig.a.id, seeded);
    const before = rig.projects.get(rig.a.id)!.config;
    await expect(rig.call('projects:update-config', { id: rig.a.id, config })).rejects.toThrow();
    expect(rig.projects.get(rig.a.id)!.config).toStrictEqual(before);
    expect(rig.events).toEqual([]);
  });

  it.each([
    ['null', null],
    ['an array', [{ env: {} }]],
    ['a string', 'env'],
    ['missing', undefined],
  ])('rejects a config that is %s without writing', async (_label, config) => {
    const rig = envRig();
    rig.projects.updateConfig(rig.a.id, seeded);
    const before = rig.projects.get(rig.a.id)!.config;
    await expect(rig.call('projects:update-config', { id: rig.a.id, config })).rejects.toThrow();
    expect(rig.projects.get(rig.a.id)!.config).toStrictEqual(before);
  });

  it('AC17 — the rejection names the key and never the value', async () => {
    const rig = envRig();
    const err = await rig
      .call('projects:update-config', { id: rig.a.id, config: { env: { TOKEN: 'S3CRET\0' } } })
      .catch((e: Error) => e);
    expect((err as Error).message).toContain('TOKEN');
    expect((err as Error).message).not.toContain('S3CRET');
  });

  it('a valid env save replaces the whole map and keeps every other field', async () => {
    const rig = envRig();
    rig.projects.updateConfig(rig.a.id, seeded);
    const res = (await rig.call('projects:update-config', {
      id: rig.a.id,
      config: { env: { B: '2', EMPTY: '' } },
    })) as { project: { config: ProjectConfig } };
    const expected = { ...seeded, env: { B: '2', EMPTY: '' } };
    expect(res.project.config).toStrictEqual(expected);
    expect(rig.projects.get(rig.a.id)!.config).toStrictEqual(expected);
  });

  it('an empty env map clears every variable', async () => {
    const rig = envRig();
    rig.setEnv(rig.a.id, { A: '1' });
    await rig.call('projects:update-config', { id: rig.a.id, config: { env: {} } });
    expect(rig.projects.get(rig.a.id)!.config.env).toStrictEqual({});
  });

  it('a save without env is not validated as env and works as before', async () => {
    const rig = envRig();
    await rig.call('projects:update-config', { id: rig.a.id, config: { model: 'opus' } });
    expect(rig.projects.get(rig.a.id)!.config).toStrictEqual({ model: 'opus' });
  });

  it('a successful save emits projects:changed', async () => {
    const rig = envRig();
    await rig.call('projects:update-config', { id: rig.a.id, config: { env: { A: '1' } } });
    expect(rig.events).toEqual(['projects:changed']);
  });
});

describe('project env at every spawn site (AC10, AC11, AC14–AC16)', () => {
  it('shells:launch (first) passes the project var and project wins over template env', async () => {
    const rig = envRig();
    rig.projects.updateConfig(rig.a.id, {
      launchCmd: { first: { argv: ['run', '${env.K}'], env: { K: 'tpl', T: 't' } } },
      env: { K: 'proj', P: '${PROJECT_NAME}' },
    });
    await rig.call('shells:launch', { projectId: rig.a.id });
    expect(rig.spawned(0).env).toStrictEqual({ K: 'proj', T: 't', P: 'alpha' });
    expect(rig.spawned(0).argv).toEqual(['run', 'proj']);
  });

  it('shells:launch (subsequent) passes the project var', async () => {
    const rig = envRig();
    rig.setEnv(rig.a.id, { API_URL: 'http://localhost:4000' });
    rig.projects.setFirstLaunched(rig.a.id, new Date());
    rig.ptyManager.spawn.mockImplementationOnce(async () => {
      const onExit = rig.ptyManager.on.mock.calls.filter((c) => c[0] === 'exit').at(-1)![1] as (
        ev: unknown,
      ) => void;
      onExit({ projectId: rig.a.id, shellIndex: 0, code: 0, uptimeMs: 10_000, earlyOutput: '' });
    });
    await rig.call('shells:launch', { projectId: rig.a.id });
    expect(rig.ptyManager.spawn).toHaveBeenCalledTimes(1);
    expect(rig.spawned(0).variant).toBe('subsequent');
    expect(rig.spawned(0).env).toStrictEqual({ API_URL: 'http://localhost:4000' });
  });

  it('shells:launch no-session fallback passes the project var on the retry', async () => {
    const rig = envRig();
    rig.setEnv(rig.a.id, { API_URL: 'http://localhost:4000' });
    rig.projects.setFirstLaunched(rig.a.id, new Date());
    rig.ptyManager.spawn.mockImplementationOnce(async () => {
      const onExit = rig.ptyManager.on.mock.calls.filter((c) => c[0] === 'exit').at(-1)![1] as (
        ev: unknown,
      ) => void;
      onExit({
        projectId: rig.a.id,
        shellIndex: 0,
        code: 1,
        uptimeMs: 100,
        earlyOutput: 'No conversation found to continue',
      });
    });
    await rig.call('shells:launch', { projectId: rig.a.id });
    expect(rig.ptyManager.spawn).toHaveBeenCalledTimes(2);
    expect(rig.spawned(1).variant).toBe('first');
    expect(rig.spawned(1).env).toStrictEqual({ API_URL: 'http://localhost:4000' });
  });

  it('shells:launch-plain passes the interpolated project vars', async () => {
    const rig = envRig();
    rig.setEnv(rig.a.id, { API_URL: 'http://localhost:4000', BIN: '${PROJECT_PATH}/bin' });
    await rig.call('shells:launch-plain', { projectId: rig.a.id });
    expect(rig.spawned(0).env).toStrictEqual({
      API_URL: 'http://localhost:4000',
      BIN: `${rig.pathA}/bin`,
    });
  });

  it('shells:launch-cli profile — project NODE_ENV wins over the profile', async () => {
    const rig = envRig();
    rig.projects.updateConfig(rig.a.id, {
      cliProfiles: [{ name: 'prof', argv: ['node'], env: { NODE_ENV: 'production', X: 'x' } }],
      env: { NODE_ENV: 'development' },
    });
    await rig.call('shells:launch-cli', { projectId: rig.a.id, profileName: 'prof' });
    expect(rig.spawned(0).env).toStrictEqual({ NODE_ENV: 'development', X: 'x' });
  });

  it('shells:launch-cli inline argv+env — project wins; inline env stays uninterpolated', async () => {
    const rig = envRig();
    rig.setEnv(rig.a.id, { E: 'proj', H: '${HOME}' });
    await rig.call('shells:launch-cli', {
      projectId: rig.a.id,
      argv: ['codex'],
      env: { E: 'inline', T: '${HOME}' },
    });
    expect(rig.spawned(0).env).toStrictEqual({ E: 'proj', T: '${HOME}', H: '/home/u' });
  });

  it('tasks:run passes the project var', async () => {
    const rig = envRig();
    writeFileSync(join(rig.pathA, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    rig.setEnv(rig.a.id, { API_URL: 'http://localhost:4000' });
    await rig.call('tasks:run', { projectId: rig.a.id, taskId: 'npm:dev' });
    expect(rig.spawned(0).argv).toEqual(['npm', 'run', 'dev']);
    expect(rig.spawned(0).env).toStrictEqual({ API_URL: 'http://localhost:4000' });
  });

  it('AC16 — a second project spawns without project A vars', async () => {
    const rig = envRig();
    rig.setEnv(rig.a.id, { API_URL: 'a-only' });
    await rig.call('shells:launch-plain', { projectId: rig.a.id });
    await rig.call('shells:launch-plain', { projectId: rig.b.id });
    expect(rig.spawned(1).env).toStrictEqual({});
  });

  it("AC14 — no vars: every site passes exactly today's env", async () => {
    const rig = envRig();
    rig.settings.set('default_launch_cmd.first', { argv: ['claude'], env: { T: '${HOME}/t' } });
    writeFileSync(join(rig.pathA, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    rig.projects.updateConfig(rig.a.id, {
      cliProfiles: [{ name: 'prof', argv: ['node'], env: { NODE_ENV: 'production' } }],
    });
    await rig.call('shells:launch', { projectId: rig.a.id });
    await rig.call('shells:launch-plain', { projectId: rig.a.id });
    await rig.call('shells:launch-cli', { projectId: rig.a.id, profileName: 'prof' });
    await rig.call('shells:launch-cli', {
      projectId: rig.a.id,
      argv: ['codex'],
      env: { I: '${HOME}' },
    });
    await rig.call('tasks:run', { projectId: rig.a.id, taskId: 'npm:dev' });
    expect([0, 1, 2, 3, 4].map((n) => rig.spawned(n).env)).toStrictEqual([
      { T: '/home/u/t' },
      {},
      { NODE_ENV: 'production' },
      { I: '${HOME}' },
      {},
    ]);
  });

  it('AC15 — each spawn reflects the config at its own spawn time', async () => {
    const rig = envRig();
    rig.setEnv(rig.a.id, { API_URL: 'old' });
    await rig.call('shells:launch-plain', { projectId: rig.a.id });
    await rig.call('projects:update-config', { id: rig.a.id, config: { env: { API_URL: 'new' } } });
    await rig.call('shells:launch-plain', { projectId: rig.a.id });
    expect(rig.spawned(0).env).toStrictEqual({ API_URL: 'old' });
    expect(rig.spawned(1).env).toStrictEqual({ API_URL: 'new' });
    expect(rig.ptyManager.write).not.toHaveBeenCalled();
  });

  it('AC17 — the persisted shell row holds argv only, never a project value', async () => {
    const rig = envRig();
    rig.setEnv(rig.a.id, { TOKEN: 'S3CRET' });
    await rig.call('shells:launch-plain', { projectId: rig.a.id });
    const rows = rig.shells.list();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('S3CRET');
  });
});

describe('app-wide env at every spawn site (AC9, AC10, AC16)', () => {
  it('shells:launch (first) carries the app var with no project vars', async () => {
    const rig = envRig();
    rig.settings.set('app_env', { X: 'app' });
    await rig.call('shells:launch', { projectId: rig.a.id });
    expect(rig.spawned(0).env).toStrictEqual({ X: 'app' });
  });

  it('shells:launch (subsequent) carries the app var', async () => {
    const rig = envRig();
    rig.settings.set('app_env', { X: 'app' });
    rig.projects.setFirstLaunched(rig.a.id, new Date());
    await rig.call('shells:launch', { projectId: rig.a.id });
    expect(rig.spawned(0).variant).toBe('subsequent');
    expect(rig.spawned(0).env).toStrictEqual({ X: 'app' });
  });

  it('shells:launch no-session fallback carries the app var on the retry', async () => {
    const rig = envRig();
    rig.settings.set('app_env', { X: 'app' });
    rig.projects.setFirstLaunched(rig.a.id, new Date());
    rig.ptyManager.spawn.mockImplementationOnce(async () => {
      const onExit = rig.ptyManager.on.mock.calls.filter((c) => c[0] === 'exit').at(-1)![1] as (
        ev: unknown,
      ) => void;
      onExit({
        projectId: rig.a.id,
        shellIndex: 0,
        code: 1,
        uptimeMs: 100,
        earlyOutput: 'No conversation found to continue',
      });
    });
    await rig.call('shells:launch', { projectId: rig.a.id });
    expect(rig.ptyManager.spawn).toHaveBeenCalledTimes(2);
    expect(rig.spawned(1).env).toStrictEqual({ X: 'app' });
  });

  it('shells:launch-plain carries the app var', async () => {
    const rig = envRig();
    rig.settings.set('app_env', { X: 'app' });
    await rig.call('shells:launch-plain', { projectId: rig.a.id });
    expect(rig.spawned(0).env).toStrictEqual({ X: 'app' });
  });

  it('shells:launch-cli profile carries the app var', async () => {
    const rig = envRig();
    rig.settings.set('app_env', { X: 'app' });
    rig.projects.updateConfig(rig.a.id, { cliProfiles: [{ name: 'prof', argv: ['node'] }] });
    await rig.call('shells:launch-cli', { projectId: rig.a.id, profileName: 'prof' });
    expect(rig.spawned(0).env).toStrictEqual({ X: 'app' });
  });

  it('shells:launch-cli inline argv carries the app var', async () => {
    const rig = envRig();
    rig.settings.set('app_env', { X: 'app' });
    await rig.call('shells:launch-cli', { projectId: rig.a.id, argv: ['codex'] });
    expect(rig.spawned(0).env).toStrictEqual({ X: 'app' });
  });

  it('tasks:run carries the app var', async () => {
    const rig = envRig();
    rig.settings.set('app_env', { X: 'app' });
    writeFileSync(join(rig.pathA, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    await rig.call('tasks:run', { projectId: rig.a.id, taskId: 'npm:dev' });
    expect(rig.spawned(0).env).toStrictEqual({ X: 'app' });
  });

  it('AC10 — a project value of the same name wins over the app value at one site', async () => {
    const rig = envRig();
    rig.settings.set('app_env', { X: 'app' });
    rig.setEnv(rig.a.id, { X: 'proj' });
    await rig.call('shells:launch-plain', { projectId: rig.a.id });
    expect(rig.spawned(0).env).toStrictEqual({ X: 'proj' });
  });

  it('AC16 — changing app_env between two spawns changes only the second', async () => {
    const rig = envRig();
    rig.settings.set('app_env', { X: 'before' });
    await rig.call('shells:launch-plain', { projectId: rig.a.id });
    rig.settings.set('app_env', { X: 'after' });
    await rig.call('shells:launch-plain', { projectId: rig.a.id });
    expect(rig.spawned(0).env).toStrictEqual({ X: 'before' });
    expect(rig.spawned(1).env).toStrictEqual({ X: 'after' });
  });
});

describe('git handlers for the Diff tab and Git panel (AC9, AC19, AC20, AC28, AC31–AC33)', () => {
  beforeEach(stubGitEnv);
  afterEach(() => { vi.unstubAllEnvs(); });

  /** A project folder (no git yet) and a handler caller whose services resolve only project 1 to it. */
  function gitRig() {
    const { base, root } = tempProject('reg-git-');
    const ipc = fakeIpcMain();
    const projects = { get: (id: number) => (id === 1 ? { id: 1, path: root } : undefined) };
    registerIpc(ipc as unknown as IpcMain, { projects } as unknown as Parameters<typeof registerIpc>[1], () => {});
    const call = (channel: string, req: unknown) => ipc.handlers.get(channel)!({}, req);
    return { base, root, call };
  }

  function repoRig() {
    const rig = gitRig();
    git(rig.root, 'init', '-q', '-b', 'main');
    return rig;
  }

  it('git:panel-status on an empty .git folder is a repo with empty lists and git\'s error text', async () => {
    const { root, call } = gitRig();
    mkdirSync(join(root, '.git'));
    const res = await call('git:panel-status', { projectId: 1 });
    expect(res).toMatchObject({ isRepo: true, branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] });
    expect(res).toMatchObject({ error: expect.stringMatching(/not a git repository/i) });
  });

  it('git:panel-status without .git is not a repo and carries no error', async () => {
    const { call } = gitRig();
    expect(await call('git:panel-status', { projectId: 1 })).toEqual({ isRepo: false, branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] });
  });

  it('git:panel-status on a real repo lists unquoted renames with origPath, UU in both groups and every untracked file, with no error', async () => {
    const { root, call } = repoRig();
    writeFileSync(join(root, 'old.ts'), 'export const x = 1;\n'.repeat(5));
    makeConflict(root);
    git(root, 'mv', 'old.ts', 'new name é.js');
    mkdirSync(join(root, 'dir', 'sub'), { recursive: true });
    writeFileSync(join(root, 'dir', 'sub', 'u1.txt'), 'u');
    writeFileSync(join(root, 'dir', 'u2.txt'), 'u');
    const res = await call('git:panel-status', { projectId: 1 }) as Record<string, unknown>;
    expect(res).not.toHaveProperty('error');
    expect(res).toMatchObject({ isRepo: true, branch: 'main' });
    expect(res.staged).toEqual(expect.arrayContaining([
      { path: 'new name é.js', status: 'R', origPath: 'old.ts' },
      { path: 'f.ts', status: 'U' },
    ]));
    expect(res.unstaged).toEqual([{ path: 'f.ts', status: 'U' }]);
    expect(res.untracked).toEqual(['dir/sub/u1.txt', 'dir/u2.txt']);
  });

  it('git:panel-status lists files named like pathspec magic exactly as git status does without literal pathspecs', async () => {
    const { root, call } = repoRig();
    for (const name of ['*.ts', ':(exclude)x', 'a.ts']) writeFileSync(join(root, name), 'one\n');
    commitAll(root);
    for (const name of ['*.ts', ':(exclude)x', 'a.ts']) writeFileSync(join(root, name), 'two\n');
    writeFileSync(join(root, '[ab].ts'), 'new\n');
    const res = await call('git:panel-status', { projectId: 1 }) as { unstaged: { path: string }[]; untracked: string[] };
    const plain = git(root, '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all');
    expect(plain).toBe(' M *.ts\0 M :(exclude)x\0 M a.ts\0?? [ab].ts\0');
    expect(res.unstaged.map((e) => e.path)).toEqual(['*.ts', ':(exclude)x', 'a.ts']);
    expect(res.untracked).toEqual(['[ab].ts']);
  });

  it('git:panel-status never runs a repo-local core.fsmonitor program', async () => {
    const { base, root, call } = repoRig();
    writeFileSync(join(root, 'a.txt'), 'a');
    const { script, marker } = markerScript(base, 'fsmonitor');
    git(root, 'config', 'core.fsmonitor', script);
    await call('git:panel-status', { projectId: 1 });
    expect(existsSync(marker)).toBe(false);
    spawnSync('git', ['status'], { cwd: root });
    expect(existsSync(marker)).toBe(true);
  });

  it.each(['git:panel-status', 'git:file-diff', 'git:diff-sides'])('%s rejects an unknown project', async (channel) => {
    const { call } = gitRig();
    await expect(call(channel, { projectId: 99, path: 'a', kind: 'unstaged' })).rejects.toThrow(/no project 99/);
  });

  it.each(['../x', '/etc/passwd', '../proj-evil/x'])('git:diff-sides and git:file-diff reject %j', async (bad) => {
    const { call } = repoRig();
    await expect(call('git:diff-sides', { projectId: 1, kind: 'untracked', path: bad })).rejects.toThrow(/path|absolute/);
    await expect(call('git:file-diff', { projectId: 1, path: bad, untracked: true })).rejects.toThrow(/path|absolute/);
    await expect(call('git:file-diff', { projectId: 1, path: 'ok.ts', origPath: bad, staged: true })).rejects.toThrow(/path|absolute/);
  });

  it('git:diff-sides rejects an unknown kind', async () => {
    const { root, call } = repoRig();
    writeFileSync(join(root, 'u.txt'), 'u\n');
    await expect(call('git:diff-sides', { projectId: 1, kind: 'worktree', path: 'u.txt' })).rejects.toThrow(/kind/);
  });

  it('git:diff-sides rejects a project that is not a git repository', async () => {
    const { root, call } = gitRig();
    writeFileSync(join(root, 'u.txt'), 'u\n');
    await expect(call('git:diff-sides', { projectId: 1, kind: 'untracked', path: 'u.txt' })).rejects.toThrow(/not a git repository/);
  });

  it('git:diff-sides returns the diff and both sides, then unchanged for the same hash', async () => {
    const { root, call } = repoRig();
    writeFileSync(join(root, 'u.txt'), 'hello\n');
    const first = await call('git:diff-sides', { projectId: 1, kind: 'untracked', path: 'u.txt' }) as { status: string; diffHash: string; diff: string };
    expect(first).toMatchObject({ status: 'ok', oldSide: { text: null, skipped: 'absent' }, newSide: { text: 'hello\n' } });
    expect(first.diff).toContain('+hello');
    await expect(call('git:diff-sides', { projectId: 1, kind: 'untracked', path: 'u.txt', ifDiffHashNot: first.diffHash })).resolves.toEqual({ status: 'unchanged' });
  });

  it('git:file-diff gives a rename diff with origPath, and tooLarge over 1 MiB', async () => {
    const { root, call } = repoRig();
    writeFileSync(join(root, 'old.ts'), 'export const x = 1;\n'.repeat(5));
    commitAll(root);
    git(root, 'mv', 'old.ts', 'new.ts');
    const rename = await call('git:file-diff', { projectId: 1, path: 'new.ts', origPath: 'old.ts', staged: true }) as { diff: string };
    expect(rename.diff).toContain('rename from old.ts');
    writeFileSync(join(root, 'big.txt'), 'line of text\n'.repeat(100_000));
    await expect(call('git:file-diff', { projectId: 1, path: 'big.txt', untracked: true })).resolves.toEqual({ diff: '', tooLarge: true });
  });

  it('git:file-diff without .git returns an empty diff', async () => {
    const { call } = gitRig();
    await expect(call('git:file-diff', { projectId: 1, path: 'a.ts' })).resolves.toEqual({ diff: '' });
  });
});

describe('roots:rescan', () => {
  function rescanRig(liveProjectIds: number[] = []) {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'rescan-db-')), 'db'));
    runMigrations(db, migrationsDir);
    const settings = new SettingsRepo(db);
    settings.seedDefaults();
    const roots = new RootsRepo(db);
    const projects = new ProjectsRepo(db);
    const ptyManager = fakePtyManager();
    ptyManager.liveShells.mockImplementation(() =>
      liveProjectIds.map((projectId) => ({ projectId, shellIndex: 0, pid: 1, startedAt: 0, lastDataAt: 0 })) as never);
    const ipc = fakeIpcMain();
    const services = { settings, roots, projects, ptyManager } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ipc as unknown as IpcMain, services, () => {});
    const rootPath = mkdtempSync(join(tmpdir(), 'rescan-root-'));
    const root = roots.add(rootPath);
    const rescan = () => ipc.handlers.get('roots:rescan')!({}, { id: root.id });
    return { projects, rootPath, rescan, liveProjectIds };
  }

  it('drops a project whose folder was removed from the root', async () => {
    const { projects, rootPath, rescan } = rescanRig();
    mkdirSync(join(rootPath, 'keep'));
    mkdirSync(join(rootPath, 'gone'));
    await rescan();
    expect(projects.list().map((p) => p.name).sort()).toEqual(['gone', 'keep']);

    rmSync(join(rootPath, 'gone'), { recursive: true });
    await rescan();

    expect(projects.list().map((p) => p.name)).toEqual(['keep']);
  });

  it('keeps a removed folder\'s project while it still has a live shell', async () => {
    const { projects, rootPath, rescan, liveProjectIds } = rescanRig();
    mkdirSync(join(rootPath, 'busy'));
    await rescan();
    liveProjectIds.push(projects.list()[0]!.id);

    rmSync(join(rootPath, 'busy'), { recursive: true });
    await rescan();

    expect(projects.list().map((p) => p.name)).toEqual(['busy']);
  });
});
