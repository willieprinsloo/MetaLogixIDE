/** Reports root interactive OMP lifecycle to MetaLogixIDE without sending prompts or tool arguments. */
import { createConnection } from 'node:net';
const transmission = { queued: 0, previous: Promise.resolve(), sequence: 0, owner: null };

function sendSocket(port, line) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let response = '';
    let finished = false;
    const done = (accepted) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(accepted);
    };
    socket.setTimeout(300, () => done(false));
    socket.once('connect', () => socket.end(line));
    socket.on('data', (chunk) => {
      response += chunk.toString();
      if (response.length > 16) done(false);
    });
    socket.once('error', () => done(false));
    socket.once('close', () => done(response === 'ok\n'));
  });
}

function transmit(port, spawn, token, report) {
  if (transmission.queued >= 8) return Promise.resolve(false);
  transmission.queued++;
  const line = JSON.stringify({ spawn, token, report }) + '\n';
  const sending = transmission.previous.then(() => sendSocket(port, line)).catch(() => false);
  transmission.previous = sending.then(() => undefined);
  return sending.finally(() => {
    transmission.queued--;
  });
}

/** Registers root-only OMP lifecycle hooks; invalid child environment leaves OMP unchanged. */
export default function installStatusExtension(pi) {
  const port = Number(process.env.METAIDE_OMP_STATUS_PORT);
  const spawn = process.env.METAIDE_OMP_STATUS_SPAWN;
  const token = process.env.METAIDE_OMP_STATUS_TOKEN;
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !spawn ||
    !token ||
    process.env.OMPCODE === '1'
  )
    return;

  const owner = Symbol();
  transmission.owner = owner;
  let root = false;
  let activeSession = '';
  let acknowledgedSession = '';
  let resyncHeartbeat = false;
  let working = false;
  let approvals = 0;
  let questions = 0;

  function snapshot() {
    return { active: working, approvals, questions };
  }

  function report(event, extra = {}) {
    if (transmission.owner !== owner || !root || !activeSession) return;
    const outgoing = {
      version: 1,
      session: activeSession,
      seq: ++transmission.sequence,
      event,
      ...extra,
    };
    void transmit(port, spawn, token, outgoing).then((accepted) => {
      if (
        accepted &&
        (event === 'heartbeat' || event === 'session_start' || event === 'session_switch')
      )
        acknowledgedSession = outgoing.session;
    });
  }

  function activate(ctx) {
    if (ctx?.hasUI !== true) return false;
    const session = ctx.sessionManager?.getSessionId?.();
    if (typeof session !== 'string' || session.length === 0) return false;
    const wasActive = root;
    root = true;
    activeSession = session;
    working = ctx.isIdle?.() === false;
    approvals = 0;
    questions = 0;
    report(wasActive ? 'session_switch' : 'session_start', snapshot());
    return true;
  }

  const heartbeat = setInterval(() => {
    if (transmission.owner !== owner) {
      clearInterval(heartbeat);
      return;
    }
    if (!root || !activeSession) return;
    resyncHeartbeat = !resyncHeartbeat;
    const event =
      acknowledgedSession === activeSession || resyncHeartbeat
        ? 'heartbeat'
        : acknowledgedSession
          ? 'session_switch'
          : 'session_start';
    report(event, snapshot());
  }, 250);
  heartbeat.unref?.();

  pi.on('session_start', (_event, ctx) => {
    activate(ctx);
  });
  pi.on('session_switch', (_event, ctx) => {
    activate(ctx);
  });
  pi.on('agent_start', (_event, ctx) => {
    if (!root && !activate(ctx)) return;
    working = true;
    report('agent_start');
  });
  pi.on('agent_end', (event) => {
    if (event?.willContinue !== true) {
      working = false;
      approvals = 0;
      questions = 0;
    }
    report('agent_end', { willContinue: event?.willContinue === true });
  });
  pi.on('tool_approval_requested', () => {
    approvals = Math.min(100, approvals + 1);
    report('approval_requested');
  });
  pi.on('tool_approval_resolved', () => {
    approvals = Math.max(0, approvals - 1);
    report('approval_resolved');
  });
  pi.on('tool_execution_start', (event) => {
    if (event?.toolName === 'ask') {
      questions = Math.min(100, questions + 1);
      report('ask_start');
    }
  });
  pi.on('tool_execution_end', (event) => {
    if (event?.toolName === 'ask') {
      questions = Math.max(0, questions - 1);
      report('ask_end');
    }
  });
}
