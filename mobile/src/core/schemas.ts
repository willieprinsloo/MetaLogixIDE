/**
 * Everything that arrives from outside the app, as schemas: relay envelopes, RPC frames and results
 * (mirroring src/shared/p2p-contract.ts on the desktop), and what is kept in storage. Untrusted input is
 * decoded here and nowhere else.
 */
import { Schema } from 'effect';

// ---- RPC results ----

export const AgentState = Schema.Literals(['idle', 'busy', 'blocked']);
export type AgentState = typeof AgentState.Type;

export const Project = Schema.Struct({ id: Schema.Number, name: Schema.String, path: Schema.String });
export type Project = typeof Project.Type;

export const ShellInfo = Schema.Struct({
  projectId: Schema.Number,
  shellIndex: Schema.Number,
  agentState: Schema.optional(Schema.NullOr(AgentState)),
  /** The command the shell was launched with; argv[0] names the tab. */
  launchArgv: Schema.optional(Schema.Array(Schema.String)),
  /** The agent the host detects running in the shell (`claude`, `codex`, `opencode`). Absent from older hosts. */
  agent: Schema.optional(Schema.NullOr(Schema.String)),
});
export type ShellInfo = typeof ShellInfo.Type;

export const DeviceInfo = Schema.Struct({ name: Schema.String, platform: Schema.String, version: Schema.String, uptime: Schema.Number });
const Ok = Schema.Struct({ ok: Schema.Literal(true) });

/** Result schema per method the phone calls. */
export const Results = {
  'device.info': DeviceInfo,
  'projects.list': Schema.Array(Project),
  'shells.alive': Schema.Array(ShellInfo),
  'shells.input': Ok,
  'shells.resize': Ok,
  'shells.launch': Schema.Struct({ shellIndex: Schema.Number }),
} as const;

export interface Params {
  'device.info': Record<string, never>;
  'projects.list': Record<string, never>;
  'shells.alive': Record<string, never>;
  'shells.input': { stream: number; bytes: string };
  'shells.resize': { stream: number; cols: number; rows: number };
  'shells.launch': { projectId: number; forceFirst?: boolean };
}
export type Method = keyof typeof Results;
export type Result<M extends Method> = (typeof Results)[M]['Type'];

/** One event of a `shells.attach` stream. Anything else the host may add later is ignored. */
export const ShellEvent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('out'), bytes: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('exit'), code: Schema.optional(Schema.NullOr(Schema.Number)) }),
]);
export type ShellEvent = typeof ShellEvent.Type;

// ---- RPC frames (host to viewer) ----

export const Frame = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('res'), id: Schema.Number, ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({
    kind: Schema.Literal('res'),
    id: Schema.Number,
    ok: Schema.Literal(false),
    error: Schema.Struct({ code: Schema.String, message: Schema.String }),
  }),
  Schema.Struct({ kind: Schema.Literal('evt'), stream: Schema.Number, data: Schema.Unknown }),
  Schema.Struct({ kind: Schema.Literal('close-stream'), stream: Schema.Number }),
  Schema.Struct({ kind: Schema.Literals(['req', 'open-stream']), id: Schema.Number }),
]);
export type Frame = typeof Frame.Type;

// ---- relay signalling ----

export const Envelope = Schema.Struct({
  type: Schema.String,
  data: Schema.optional(Schema.Struct({
    session: Schema.optional(Schema.String),
    sdp: Schema.optional(Schema.String),
    candidate: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String),
    ice_servers: Schema.optional(Schema.Unknown),
    iceServers: Schema.optional(Schema.Unknown),
  })),
});
export type Envelope = typeof Envelope.Type;

export const IceServer = Schema.Struct({
  urls: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  username: Schema.optional(Schema.String),
  credential: Schema.optional(Schema.String),
});
export type IceServer = typeof IceServer.Type;

const CONNECT_CODE = /^[A-Za-z0-9-]{4,32}$/;
export const ConnectCode = Schema.String.check(Schema.isPattern(CONNECT_CODE));

/** First secure message of a pairing: the desktop's name and the code to dial it back on. */
export const PairHello = Schema.Struct({
  hello: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
});

// ---- storage ----

export const Device = Schema.Struct({ id: Schema.String, name: Schema.String, code: Schema.String, addedAt: Schema.Number });
export type Device = typeof Device.Type;

export const StoredSettings = Schema.Struct({
  relayHost: Schema.optional(Schema.String),
  relayPort: Schema.optional(Schema.Number),
  deviceName: Schema.optional(Schema.String),
});
