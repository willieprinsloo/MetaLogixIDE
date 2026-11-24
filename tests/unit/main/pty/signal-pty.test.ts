import { describe, it, expect, vi, afterEach } from 'vitest';
import { signalPty } from '@main/pty/manager';

function throwingOnSignal() {
  return { kill: vi.fn((signal?: string) => { if (signal) throw new Error('Signals not supported on windows.'); }) };
}

describe('signalPty', () => {
  afterEach(() => vi.restoreAllMocks());

  it('on Windows kills the PTY without a signal and never touches a process group', () => {
    const groupKill = vi.spyOn(process, 'kill');
    const pty = throwingOnSignal();
    expect(() => signalPty(pty, 1234, 'SIGTERM', 'win32')).not.toThrow();
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(pty.kill).toHaveBeenCalledWith();
    expect(groupKill).not.toHaveBeenCalled();
  });

  it('on POSIX signals the whole process group and leaves the PTY alone', () => {
    const groupKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const pty = { kill: vi.fn() };
    signalPty(pty, 1234, 'SIGTERM', 'darwin');
    expect(groupKill).toHaveBeenCalledWith(-1234, 'SIGTERM');
    expect(pty.kill).not.toHaveBeenCalled();
  });

  it('on POSIX falls back to signalling the PTY when the group is gone', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH'); });
    const pty = { kill: vi.fn() };
    signalPty(pty, 1234, 'SIGKILL', 'linux');
    expect(pty.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('never throws when both the group and the PTY are already gone', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH'); });
    const pty = { kill: vi.fn(() => { throw new Error('gone'); }) };
    expect(() => signalPty(pty, 1234, 'SIGKILL', 'linux')).not.toThrow();
    expect(() => signalPty(pty, 1234, 'SIGKILL', 'win32')).not.toThrow();
  });
});
