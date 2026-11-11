import { describe, expect, test } from 'vitest';
import { WebRtcTransport, type TransportWorker } from '../transport';
import { PeerEngine, type WorkerEvent } from '../worker/peerEngine';

// Opt-in: METAIDE_P2P_INTEGRATION=1 node node_modules/vitest/vitest.mjs run src/main/p2p/__tests__/transport.spike.test.ts
// Must run under plain Node: @roamhq/wrtc crashes the process under ELECTRON_RUN_AS_NODE (pnpm test).
// Runs two real RTCPeerConnections (@roamhq/wrtc) in Node, with SDP/ICE exchanged
// through plain JS calls (no signaling relay, no Electron IPC).
const enabled = process.env['METAIDE_P2P_INTEGRATION'] === '1';

async function inProcessWorker(): Promise<TransportWorker> {
  const wrtc = (await import('@roamhq/wrtc')).default as unknown as { RTCPeerConnection: never };
  let sink: (e: WorkerEvent) => void = () => {};
  const engine = new PeerEngine({ PC: wrtc.RTCPeerConnection, emit: (e) => sink(e) });
  return {
    call: (cmd, ...args) => engine.handle(cmd, args),
    onEvent: (cb) => { sink = cb; },
    destroy: () => { void engine.handle('close', []); },
  };
}

describe.skipIf(!enabled)('WebRtcTransport spike (two real peers, in-process)', () => {
  test('host and viewer connect and exchange bytes both ways', async () => {
    const [wa, wb] = await Promise.all([inProcessWorker(), inProcessWorker()]);
    const host = new WebRtcTransport({ iceServers: [], role: 'host', createWorker: () => wa });
    const viewer = new WebRtcTransport({ iceServers: [], role: 'viewer', createWorker: () => wb });

    const candsToViewer: string[] = [];
    const candsToHost: string[] = [];
    host.on('local-candidate', (c: string) => candsToViewer.push(c));
    viewer.on('local-candidate', (c: string) => candsToHost.push(c));

    const opened = Promise.all([
      new Promise<void>((r) => host.once('open', r)),
      new Promise<void>((r) => viewer.once('open', r)),
    ]);
    const hostGot = new Promise<Uint8Array>((r) => host.once('message', r));
    const viewerGot = new Promise<Uint8Array>((r) => viewer.once('message', r));

    // Host creates the data channel before the offer so the SDP carries it.
    await host.openDataChannel('ctl');
    const offer = await host.createOffer();
    const answer = await viewer.createAnswer(offer);
    await host.setRemoteDescription(answer);
    // Trickle: feed everything gathered so far, then keep forwarding.
    const pump = setInterval(async () => {
      for (const c of candsToViewer.splice(0)) await viewer.addIceCandidate(c);
      for (const c of candsToHost.splice(0)) await host.addIceCandidate(c);
    }, 20);

    await opened;
    clearInterval(pump);
    host.send(new TextEncoder().encode('hello-from-host'));
    viewer.send(new TextEncoder().encode('hello-from-viewer'));
    expect(new TextDecoder().decode(await viewerGot)).toBe('hello-from-host');
    expect(new TextDecoder().decode(await hostGot)).toBe('hello-from-viewer');
    host.close();
    viewer.close();
  }, 20_000);
});
