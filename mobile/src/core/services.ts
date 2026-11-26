/**
 * What the protocol core needs from the platform, as services. React Native provides them in
 * src/platform; the interop tests provide in-memory ones, so the core runs under Node unchanged.
 */
import { Context, type Effect } from 'effect';
import type { RawTransport } from './noise';
import type { IceServer } from './schemas';

/** A connected-or-connecting byte socket to the relay. */
export interface RelaySocket {
  write(bytes: Uint8Array): void;
  close(): void;
  onOpen(cb: () => void): void;
  onData(cb: (bytes: Uint8Array) => void): void;
  /** Fires once, for errors and normal closes alike. */
  onClose(cb: () => void): void;
}

/** The answering end of a WebRTC data channel. Events as RawTransport, plus 'open' and 'candidate' (JSON string). */
export interface Peer extends RawTransport {
  /** Applies the host's offer and returns the local answer SDP. */
  answer(offerSdp: string): Promise<string>;
  addCandidate(candidateJson: string): Promise<void>;
  on(ev: 'message', cb: (m: Uint8Array) => void): unknown;
  on(ev: 'close' | 'open', cb: () => void): unknown;
  on(ev: 'candidate', cb: (candidateJson: string) => void): unknown;
}

/** Opens TCP connections to the signalling relay. */
export class Relay extends Context.Service<Relay, {
  connect(host: string, port: number): RelaySocket;
}>()('metaide/core/Relay') {}

/** Creates WebRTC peer connections. */
export class Peers extends Context.Service<Peers, {
  create(iceServers: ReadonlyArray<IceServer>): Peer;
}>()('metaide/core/Peers') {}

/** Settings and paired machines in app storage; the device key in the platform keychain. */
export class Storage extends Context.Service<Storage, {
  get(key: string): Effect.Effect<string | null>;
  set(key: string, value: string): Effect.Effect<void>;
  getSecret(key: string): Effect.Effect<string | null>;
  setSecret(key: string, value: string): Effect.Effect<void>;
}>()('metaide/core/Storage') {}

/** Cryptographic randomness, and the name this device pairs under until the user picks one. */
export class Platform extends Context.Service<Platform, {
  randomBytes(n: number): Uint8Array;
  readonly defaultName: string;
}>()("metaide/core/Platform") {}
