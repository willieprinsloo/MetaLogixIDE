/**
 * Runs the phone's connection path from this computer (Node sockets + @roamhq/wrtc) against the real
 * relay, to tell protocol problems from phone problems. From the repo root:
 *
 *   npm run probe -- <connect-code> [relay-host] [relay-port]     (from mobile/)
 *
 * It uses a throwaway identity and no pairing, so a healthy host completes the Noise handshake and
 * then hangs up on it as an untrusted device. That outcome is the pass.
 */
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { Emitter } from '../src/core/bytes';
import { connect, type IceServer, type Peer, type Platform } from '../src/core/link';
import { deviceKeyFromSeed } from '../src/core/noise';

const wrtc = createRequire(import.meta.url)('@roamhq/wrtc') as { RTCPeerConnection: new (c: { iceServers: IceServer[] }) => RTCPeerConnection };
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

class NodePeer extends Emitter {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null = null;
  constructor(ice: IceServer[]) {
    super();
    log('ice servers:', JSON.stringify(ice).replace(/"credential":"[^"]*"/g, '"credential":"…"'));
    this.pc = new wrtc.RTCPeerConnection({ iceServers: ice });
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) { log('local candidate:', ev.candidate.candidate.split(' ').slice(2, 8).join(' ')); this.emit('candidate', JSON.stringify(ev.candidate.toJSON())); }
    };
    this.pc.oniceconnectionstatechange = () => log('ice state:', this.pc.iceConnectionState);
    this.pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(this.pc.connectionState)) this.emit('close'); };
    this.pc.ondatachannel = (ev) => {
      const dc = (this.dc = ev.channel);
      dc.binaryType = 'arraybuffer';
      dc.onopen = () => { log('data channel open'); this.emit('open'); };
      dc.onclose = () => this.emit('close');
      dc.onmessage = (m) => this.emit('message', new Uint8Array(m.data as ArrayBuffer));
    };
  }
  async answer(sdp: string): Promise<string> {
    log('got offer');
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    const a = await this.pc.createAnswer();
    await this.pc.setLocalDescription(a);
    return a.sdp ?? '';
  }
  async addCandidate(c: string): Promise<void> {
    const j = JSON.parse(c) as RTCIceCandidateInit;
    log('remote candidate:', String(j.candidate).split(' ').slice(2, 8).join(' '));
    await this.pc.addIceCandidate(j);
  }
  send(b: Uint8Array): void { if (this.dc?.readyState === 'open') this.dc.send(new Uint8Array(b)); }
  close(): void { try { this.pc.close(); } catch { /* closed */ } }
}

const [code, host = 'remote.metalogix.solutions', port = '7100'] = process.argv.slice(2);
if (!code) { console.error('usage: probe <connect-code> [relay-host] [relay-port]'); process.exit(2); }

const platform: Platform = {
  connect(h, p) {
    const sock = net.connect({ host: h, port: p });
    return {
      onOpen: (cb) => sock.once('connect', () => { log(`relay connected ${h}:${p}`); cb(); }),
      onData: (cb) => sock.on('data', (d: Buffer) => cb(new Uint8Array(d))),
      onClose: (cb) => { sock.once('close', () => { log('relay socket closed'); cb(); }); sock.on('error', (e) => log('relay error:', e.message)); },
      write: (b) => { sock.write(b); },
      close: () => sock.destroy(),
    };
  },
  createPeer: (ice) => new NodePeer(ice) as unknown as Peer,
};

const key = deviceKeyFromSeed(new Uint8Array(randomBytes(32)));
connect({ platform, relay: { host, port: Number(port) }, code, deviceKey: key, expectedDevice: process.env.EXPECT ?? '', timeoutMs: 20_000 }).then(
  async (conn) => {
    log('noise handshake complete');
    try {
      await conn.rpc.call('device.info', {}, 5000);
      log('RESULT: unexpected, host served an unknown device');
    } catch (e) {
      log(`RESULT: path works end to end (host then refused the unknown device: ${(e as Error).message}, reason=${conn.remoteReason()})`);
    }
    process.exit(0);
  },
  (e: Error) => { log('RESULT: failed at', e.message); process.exit(1); },
);
