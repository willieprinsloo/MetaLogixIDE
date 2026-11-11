/**
 * Renderer-side WebRTC engine. Owns exactly one RTCPeerConnection at a time.
 * Pure (constructor is injected) so it can run in the hidden worker window
 * (Chromium) or under @roamhq/wrtc in Node for the opt-in integration test.
 */
export type WorkerEvent =
  | { type: 'local-candidate'; cand: string }
  | { type: 'message'; bytes: Uint8Array }
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'error'; message: string };

export type WorkerCommand =
  | 'create-pc'
  | 'create-offer'
  | 'create-answer'
  | 'set-remote-description'
  | 'add-ice-candidate'
  | 'open-dc'
  | 'send'
  | 'close';

export interface PeerEngineOpts {
  PC: new (cfg: { iceServers: RTCIceServer[] }) => RTCPeerConnection;
  emit: (e: WorkerEvent) => void;
}

export class PeerEngine {
  #pc: RTCPeerConnection | null = null;
  #dc: RTCDataChannel | null = null;
  constructor(private readonly o: PeerEngineOpts) {}

  async handle(cmd: WorkerCommand, args: unknown[]): Promise<unknown> {
    switch (cmd) {
      case 'create-pc': return this.#create(args[0] as RTCIceServer[]);
      case 'create-offer': return this.#offer();
      case 'create-answer': return this.#answer(args[0] as string);
      case 'set-remote-description': return this.#pcOrThrow().setRemoteDescription({ type: args[1] === 'offer' ? 'offer' : 'answer', sdp: args[0] as string });
      case 'add-ice-candidate': return this.#pcOrThrow().addIceCandidate(JSON.parse(args[0] as string));
      case 'open-dc': return this.#openDc(args[0] as string);
      case 'send': return this.#send(args[0] as Uint8Array);
      case 'close': return this.#close();
      default: throw new Error(`unknown command: ${String(cmd)}`);
    }
  }

  #pcOrThrow(): RTCPeerConnection {
    if (!this.#pc) throw new Error('peer connection not created');
    return this.#pc;
  }

  #create(iceServers: RTCIceServer[]): void {
    this.#close();
    const pc = new this.o.PC({ iceServers });
    this.#pc = pc;
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.o.emit({ type: 'local-candidate', cand: JSON.stringify(ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate) });
    };
    pc.ondatachannel = (ev) => this.#adopt(ev.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.o.emit({ type: 'close' });
    };
  }

  #adopt(dc: RTCDataChannel): void {
    // The Noise framing assumes an ordered, reliable channel. WebRTC's default (omit maxRetransmits and
    // maxPacketLifeTime) is exactly that; never pass `null` for them, WebIDL coerces it to 0 (unreliable).
    if (dc.ordered === false || (dc.maxRetransmits ?? null) !== null || (dc.maxPacketLifeTime ?? null) !== null) {
      this.o.emit({ type: 'error', message: 'data channel must be ordered and reliable' });
      try { dc.close(); } catch { /* already closed */ }
      return;
    }
    this.#dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => this.o.emit({ type: 'open' });
    dc.onclose = () => this.o.emit({ type: 'close' });
    dc.onerror = () => this.o.emit({ type: 'error', message: 'data channel error' });
    dc.onmessage = (ev) => {
      const d = ev.data as ArrayBuffer | string;
      this.o.emit({ type: 'message', bytes: typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d) });
    };
    if (dc.readyState === 'open') this.o.emit({ type: 'open' });
  }

  #openDc(label: string): void {
    // `undefined` is required because #adopt compares `?? null`; some engine versions
    // expose different defaults. Explicit values prevent a future surprise.
    this.#adopt(this.#pcOrThrow().createDataChannel(label, { ordered: true, maxRetransmits: undefined, maxPacketLifeTime: undefined }));
  }

  async #offer(): Promise<string> {
    const pc = this.#pcOrThrow();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return offer.sdp ?? '';
  }

  async #answer(offerSdp: string): Promise<string> {
    const pc = this.#pcOrThrow();
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return answer.sdp ?? '';
  }

  #send(bytes: Uint8Array): void {
    if (!this.#dc || this.#dc.readyState !== 'open') throw new Error('data channel not open');
    this.#dc.send(bytes as unknown as ArrayBuffer);
  }

  #close(): void {
    const dc = this.#dc, pc = this.#pc;
    this.#dc = null; this.#pc = null;
    if (dc) { dc.onclose = null; try { dc.close(); } catch { /* already closed */ } }
    if (pc) { pc.onconnectionstatechange = null; try { pc.close(); } catch { /* already closed */ } }
  }
}
