import { PeerEngine, type WorkerCommand, type WorkerEvent } from '../../main/p2p/worker/peerEngine';

interface P2pBridge {
  onCommand(cb: (id: number, cmd: WorkerCommand, args: unknown[]) => void): void;
  reply(id: number, ok: boolean, value: unknown): void;
  emit(e: WorkerEvent): void;
}

const bridge = (window as unknown as { p2p: P2pBridge }).p2p;
const engine = new PeerEngine({ PC: RTCPeerConnection, emit: (e) => bridge.emit(e) });

bridge.onCommand((id, cmd, args) => {
  engine.handle(cmd, args).then(
    (v) => bridge.reply(id, true, v ?? null),
    (err) => bridge.reply(id, false, err instanceof Error ? err.message : String(err)),
  );
});
