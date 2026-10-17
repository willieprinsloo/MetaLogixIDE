import { EventEmitter, once } from 'node:events';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

const servers: Server[] = [];
afterEach(() => { for (const server of servers) server.close(); servers.length = 0; });

describe('app-owned OMP extension', () => {
  it('reports root lifecycle without sending prompt, tool args or Herdr data', async () => {
    const reports: Array<Record<string, unknown>> = [];
    let complete: () => void = () => {};
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    const server = createServer((socket) => {
      let message = '';
      socket.on('data', (part: Buffer) => { message += part.toString(); });
      socket.on('end', () => {
        const parsed: unknown = JSON.parse(message);
        if (typeof parsed === 'object' && parsed !== null && 'report' in parsed && typeof parsed.report === 'object' && parsed.report !== null) {
          reports.push({ ...parsed.report });
          if (reports.length === 7) complete();
        }
        socket.end('ok\n');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address !== 'object' || address === null) throw new Error('listener missing');
    const old = [process.env.METAIDE_OMP_STATUS_PORT, process.env.METAIDE_OMP_STATUS_SPAWN, process.env.METAIDE_OMP_STATUS_TOKEN, process.env.OMPCODE];
    process.env.METAIDE_OMP_STATUS_PORT = String(address.port);
    process.env.METAIDE_OMP_STATUS_SPAWN = 'owned-spawn';
    process.env.METAIDE_OMP_STATUS_TOKEN = 'owned-token';
    delete process.env.OMPCODE;
    try {
      const location = new URL('../../../../resources/omp-status-extension.js', import.meta.url).href;
      const extension: unknown = await import(location);
      if (typeof extension !== 'object' || extension === null || !('default' in extension) || typeof extension.default !== 'function') throw new Error('extension factory missing');
      const handlers = new Map<string, (event: Record<string, unknown>, context: Record<string, unknown>) => void>();
      extension.default({ on: (name: string, handler: (event: Record<string, unknown>, context: Record<string, unknown>) => void) => { handlers.set(name, handler); } });
      const context = { hasUI: true, sessionManager: { getSessionId: () => 'session-1' }, isIdle: () => true };
      handlers.get('session_start')?.({}, { hasUI: false });
      handlers.get('session_start')?.({}, { hasUI: true, sessionManager: { getSessionId: () => '' } });
      handlers.get('session_start')?.({}, context);
      handlers.get('agent_start')?.({}, context);
      handlers.get('tool_approval_requested')?.({ reason: 'secret', args: { token: 'do-not-send' } }, context);
      handlers.get('tool_approval_resolved')?.({}, context);
      handlers.get('tool_execution_start')?.({ toolName: 'ask', prompt: 'secret', args: 'do-not-send' }, context);
      handlers.get('tool_execution_end')?.({ toolName: 'ask', result: 'do-not-send' }, context);
      handlers.get('tool_execution_start')?.({ toolName: 'bash', args: 'do-not-send' }, context);
      handlers.get('agent_end')?.({}, context);
      await completed;
      expect(reports.map((report) => report.event)).toEqual(['session_start', 'agent_start', 'approval_requested', 'approval_resolved', 'ask_start', 'ask_end', 'agent_end']);
      expect(JSON.stringify(reports)).not.toContain('do-not-send');
      expect(JSON.stringify(reports)).not.toContain('secret');
      process.env.OMPCODE = '1';
      const nestedHandlers: string[] = [];
      extension.default({ on: (name: string) => { nestedHandlers.push(name); } });
      expect(nestedHandlers).toEqual([]);
      delete process.env.OMPCODE;
      process.env.METAIDE_OMP_STATUS_PORT = 'invalid-port';
      const invalidHandlers: string[] = [];
      extension.default({ on: (name: string) => { invalidHandlers.push(name); } });
      expect(invalidHandlers).toEqual([]);
    } finally {
      for (const [name, value] of [['METAIDE_OMP_STATUS_PORT', old[0]], ['METAIDE_OMP_STATUS_SPAWN', old[1]], ['METAIDE_OMP_STATUS_TOKEN', old[2]], ['OMPCODE', old[3]]] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, name); else process.env[name] = value;
      }
    }
  });
});

async function waitForReport(reports: Array<Record<string, unknown>>, signal: EventEmitter, match: (report: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const found = reports.find(match);
  if (found) return found;
  for (;;) {
    const [next] = await once(signal, 'report');
    if (typeof next === 'object' && next !== null && match(next as Record<string, unknown>)) return next as Record<string, unknown>;
  }
}

describe('OMP report-channel recovery', () => {
  it('sends full-current-state heartbeats after lost completion and blocker resolution without private data', async () => {
    const reports: Array<Record<string, unknown>> = [];
    const signal = new EventEmitter();
    let drops = 0;
    let dropFirstAck = true;
    let drop = false;
    const server = createServer((socket) => {
      let message = '';
      socket.on('data', (part: Buffer) => { message += part.toString(); });
      socket.on('end', () => {
        const envelope: unknown = JSON.parse(message);
        if (typeof envelope === 'object' && envelope !== null && 'report' in envelope && typeof envelope.report === 'object' && envelope.report !== null && !drop) {
          const report = { ...envelope.report };
          reports.push(report);
          signal.emit('report', report);
          if (dropFirstAck) { dropFirstAck = false; socket.destroy(); }
          else socket.end('ok\n');
        } else {
          if (++drops === 2) signal.emit('dropped-twice');
          socket.destroy();
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address !== 'object' || address === null) throw new Error('listener missing');
    const prior = [process.env.METAIDE_OMP_STATUS_PORT, process.env.METAIDE_OMP_STATUS_SPAWN, process.env.METAIDE_OMP_STATUS_TOKEN, process.env.OMPCODE];
    process.env.METAIDE_OMP_STATUS_PORT = String(address.port);
    process.env.METAIDE_OMP_STATUS_SPAWN = 'recovering-spawn';
    process.env.METAIDE_OMP_STATUS_TOKEN = 'recovering-token';
    delete process.env.OMPCODE;
    try {
      const extension: unknown = await import(new URL('../../../../resources/omp-status-extension.js', import.meta.url).href);
      if (typeof extension !== 'object' || extension === null || !('default' in extension) || typeof extension.default !== 'function') throw new Error('extension factory missing');
      const handlers = new Map<string, (event: Record<string, unknown>, context: Record<string, unknown>) => void>();
      extension.default({ on: (event: string, handler: (event: Record<string, unknown>, context: Record<string, unknown>) => void) => { handlers.set(event, handler); } });
      const context = { hasUI: true, sessionManager: { getSessionId: () => 'session-recover' }, isIdle: () => false };
      handlers.get('session_start')?.({}, context);
      await waitForReport(reports, signal, (report) => report.event === 'session_start');
      await waitForReport(reports, signal, (report) => report.event === 'heartbeat' && report.session === 'session-recover' && report.active === true);
      handlers.get('agent_start')?.({}, context);
      handlers.get('tool_approval_requested')?.({ prompt: 'PRIVATE', args: 'PRIVATE' }, context);
      await waitForReport(reports, signal, (report) => report.event === 'approval_requested');
      drop = true;
      handlers.get('tool_approval_resolved')?.({}, context);
      handlers.get('agent_end')?.({}, context);
      await once(signal, 'dropped-twice');
      drop = false;
      const recovered = await waitForReport(reports, signal, (report) => report.event === 'heartbeat' && report.active === false && report.approvals === 0 && report.questions === 0);
      expect(recovered.seq).toEqual(expect.any(Number));
      expect(JSON.stringify(reports)).not.toContain('PRIVATE');
    } finally {
      for (const [name, value] of [['METAIDE_OMP_STATUS_PORT', prior[0]], ['METAIDE_OMP_STATUS_SPAWN', prior[1]], ['METAIDE_OMP_STATUS_TOKEN', prior[2]], ['OMPCODE', prior[3]]] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, name); else process.env[name] = value;
      }
    }
  });
});
