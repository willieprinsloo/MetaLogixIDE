/** React Native implementations of the pieces the protocol core takes by injection. */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform as RN } from 'react-native';
import TcpSocket from 'react-native-tcp-socket';
import { RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } from 'react-native-webrtc';
import { Emitter, utf8Encode } from '../core/bytes';
import { Fleet, type Storage } from '../core/fleet';
import type { IceServer, Peer, Platform, RelaySocket } from '../core/link';

function connectTcp(host: string, port: number): RelaySocket {
  let onOpen = () => {};
  let onData: (b: Uint8Array) => void = () => {};
  let onClose = () => {};
  let closed = false;
  const end = () => {
    if (closed) return;
    closed = true;
    onClose();
  };
  const sock = TcpSocket.createConnection({ host, port }, () => {
    // Keeps NATs from silently dropping the idle signalling socket (as the desktop client does).
    try { sock.setKeepAlive(true, 30_000); } catch { /* best effort */ }
    onOpen();
  });
  sock.on('data', (d) => onData(typeof d === 'string' ? utf8Encode(d) : new Uint8Array(d)));
  sock.on('error', () => { sock.destroy(); end(); });
  sock.on('close', end);
  return {
    onOpen: (cb) => { onOpen = cb; },
    onData: (cb) => { onData = cb; },
    onClose: (cb) => { onClose = cb; },
    write: (bytes) => { if (!closed) sock.write(bytes); },
    close: () => { if (!closed) sock.destroy(); },
  };
}

/** The slice of react-native-webrtc's data channel used here (its own typings are event-target-shim generics). */
interface DataChannel {
  readonly ordered: boolean;
  readonly maxRetransmits?: number;
  readonly maxPacketLifeTime?: number;
  readonly readyState: string;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: string, cb: (ev: { data?: unknown }) => void): void;
}
type Listenable = { addEventListener(type: string, cb: (ev: never) => void): void };

class RnPeer extends Emitter {
  readonly #pc: RTCPeerConnection;
  #dc: DataChannel | null = null;
  #closed = false;

  constructor(iceServers: IceServer[]) {
    super();
    const pc = (this.#pc = new RTCPeerConnection({ iceServers }));
    const on = pc as unknown as Listenable;
    on.addEventListener('icecandidate', (ev: { candidate: { toJSON(): unknown } | null }) => {
      if (ev.candidate) this.emit('candidate', JSON.stringify(ev.candidate.toJSON()));
    });
    on.addEventListener('datachannel', (ev: { channel: DataChannel }) => this.#adopt(ev.channel));
    on.addEventListener('connectionstatechange', () => {
      const st = pc.connectionState;
      if (st === 'failed' || st === 'closed') this.#ended();
    });
  }

  #adopt(dc: DataChannel): void {
    // The Noise framing needs an ordered, reliable channel; the host creates it that way. The native
    // module reports "no limit" as -1 or 65535 rather than leaving the field unset, as browsers do.
    const limited = (v: number | undefined) => typeof v === 'number' && v >= 0 && v < 65535;
    if (dc.ordered === false || limited(dc.maxRetransmits) || limited(dc.maxPacketLifeTime)) {
      this.close();
      return;
    }
    this.#dc = dc;
    dc.addEventListener('open', () => this.emit('open'));
    dc.addEventListener('close', () => this.#ended());
    dc.addEventListener('message', (ev) => {
      const d = ev.data;
      this.emit('message', typeof d === 'string' ? utf8Encode(d) : new Uint8Array(d as ArrayBuffer));
    });
    if (dc.readyState === 'open') this.emit('open');
  }

  async answer(offerSdp: string): Promise<string> {
    await this.#pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerSdp }));
    const answer = (await this.#pc.createAnswer()) as { sdp?: string };
    await this.#pc.setLocalDescription(answer as RTCSessionDescription);
    return answer.sdp ?? '';
  }

  async addCandidate(candidateJson: string): Promise<void> {
    await this.#pc.addIceCandidate(new RTCIceCandidate(JSON.parse(candidateJson) as ConstructorParameters<typeof RTCIceCandidate>[0]));
  }

  send(bytes: Uint8Array): void {
    if (this.#closed || !this.#dc || this.#dc.readyState !== 'open') return;
    try { this.#dc.send(bytes); } catch { this.close(); }
  }

  close(): void {
    if (this.#closed) return;
    const dc = this.#dc;
    this.#ended();
    try { dc?.close(); } catch { /* already closed */ }
    try { this.#pc.close(); } catch { /* already closed */ }
  }

  #ended(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit('close');
    try { this.#pc.close(); } catch { /* already closed */ }
  }
}

const platform: Platform = {
  connect: connectTcp,
  createPeer: (iceServers) => new RnPeer(iceServers) as unknown as Peer,
};

const storage: Storage = {
  get: (k) => AsyncStorage.getItem(`metaide:${k}`),
  set: (k, v) => AsyncStorage.setItem(`metaide:${k}`, v),
  getSecret: (k) => SecureStore.getItemAsync(`metaide_${k}`),
  setSecret: (k, v) => SecureStore.setItemAsync(`metaide_${k}`, v, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
};

export const fleet = new Fleet({
  platform,
  storage,
  randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
  defaultDeviceName: RN.OS === 'ios' ? 'iPhone' : 'Android phone',
});
