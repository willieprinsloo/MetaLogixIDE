# metaIDE Peer-to-Peer Fleet — Design

**Status:** Draft for approval
**Date:** 2026-10-26
**Owner:** Willie Prinsloo
**Related:** MetaConnect (`/Users/wlprinsloo/Documents/Projects/metaconnect`) ·
MetaRemote (`/Users/wlprinsloo/Documents/Projects/remote`)

---

## 1. Intent

Let one person work across every machine they own as if those machines
were one. Sitting at the laptop, you can see the projects on your
tower, drop into a running Claude shell on it, read and edit files on
it, and pick up a Claude session on whichever box last touched it —
without leaving metaIDE and without SSH.

The target is the *owner's own fleet* first (one human, several
machines). Team sharing is a later layer that reuses the same plumbing.

### The reuse decision

The MetaLogix ecosystem already has the hard parts solved:

- **MetaConnect** is a self-hosted relay with signaling, embedded
  pion/turn, TLS, token-based agent identity, and a session broker
  (`internal/mrsession`) that routes typed control frames between
  authorized peers. It is already deployed at `165.232.97.123` and
  proven for live cross-internet media sessions.
- **MetaRemote** has already paved the road: Rust host + viewer that
  mint a session over MetaConnect, do an authenticated WebRTC
  handshake, run DTLS-SRTP end-to-end, and stream real traffic over
  TURN. The signaling protocol has a type tag (`protocol.TypeMetaRemote`)
  that keeps MetaRemote's control frames isolated from the rest of
  MetaConnect's tunneling traffic.

metaIDE P2P is **the IDE-shaped sibling of MetaRemote on the same
rails.** Where MetaRemote carries desktop pixels, metaIDE P2P carries
typed RPC (projects, shells, Claude sessions, files). Both use
MetaConnect's signaling/TURN and the same mint-token-then-WebRTC
pattern. The crucial simplification: **metaIDE itself is both client
and server.** Any running IDE instance is reachable from any other.
No separate host daemon in v1.

### Why now

- The user owns multiple dev machines; current workflow is SSH, which
  loses metaIDE's project/shell/Claude-session model.
- MetaConnect + the mrsession broker + the mr-core signaling frame
  format are all production-tested — building metaIDE on top of them
  is adding one new frame type and one new host binary, not an
  infrastructure project.
- Electron ships Chromium → WebRTC is free client-side.

### Success looks like

- From any metaIDE instance, I open the **Machines** panel and see my
  other online machines.
- Clicking a project on a remote machine opens it in a new pane *in my
  current window*, with its shells streaming live over the P2P link.
- Keystrokes / resize / output latency on a remote shell feel
  slightly-slow-local: sub-100 ms LAN, sub-250 ms direct WAN, worst
  case ~400 ms through TURN.
- Closing the laptop and opening the desktop lets me resume the exact
  Claude session that was running on the laptop.

---

## 2. Goals, non-goals, anti-goals

### Goals

1. Ride **MetaConnect** for signaling + TURN. No new relay infrastructure.
2. Reuse the **mrsession** broker pattern — one new `TypeMetaIDE` frame
   type, same session FSM, same ephemeral TURN credentials, same TLS.
3. Preserve metaIDE's data model remotely. Projects, shells, Claude
   sessions, and PTY state are addressable over the wire.
4. End-to-end encrypted. The relay never sees payload.
5. Offline-tolerant. Peer disconnect ⇒ reconnect overlay, not crash.
6. Owner-fleet trust model. Devices paired to the same identity trust
   each other fully. No ACL ceremony for the solo case.

### Non-goals (v1)

- Multi-cursor collaborative editing. Edits are single-writer; LWW on save.
- Dropbox-style always-on file sync. Browse and edit remote files on
  demand.
- Team mode (sharing with other humans). Protocol allows it; v1 is
  single-owner.
- Mobile client.
- Any rewrite of MetaConnect or MetaRemote. If a change is needed in
  MetaConnect, it is *additive* (new frame type, new session kind) and
  owner-reviewed in the metaconnect repo as a separate change.

### Anti-goals

- Another SSH wrapper. We fail if the shipped feature is just
  `ssh && tmux`.
- A new signaling relay. MetaConnect exists for this. We fail if we
  build a parallel one.
- Pixel streaming. That's MetaRemote. We fail if the two products
  overlap.
- Phoning home. No telemetry, no vendor accounts.
- Rust rewrite of metaIDE main-process logic. The ground truth for
  shells / Claude sessions is in `src/main/`; the host must reuse it,
  not re-implement.

---

## 3. The shape of the system

Every machine runs the same metaIDE binary. Each instance is both
client (sees other machines in its Machines panel) and server
(answers RPC from them) at the same time. "Client" and "server" below
refer to roles within a single session, not separate products.

```
  ┌─────────── metaIDE on Laptop ────────────┐
  │  Sidebar                   Panes          │
  │  ┌───────────┐             ┌────────────┐ │
  │  │ Machines  │             │ StarSkim @ │ │
  │  │  • Laptop │ ─ selects → │   Tower    │ │
  │  │  • Tower  │             │ ◉ Shell    │ │
  │  │  • NAS    │             └────────────┘ │
  │  └───────────┘                             │
  │  Electron main ⇄ p2p/hub ⇄ data channel   │
  └──────────────────────┬────────────────────┘
                         │
            ┌────── MetaConnect ──────┐
            │ mrsignald + mrsession   │
            │ + embedded pion/turn    │
            │  (TypeMetaIDE route)    │
            └───────────┬─────────────┘
                        │
  ┌─────────────────────┴────────────────────┐
  │          metaIDE on Tower                 │
  │  (same binary; serving half is on)        │
  │  Electron main ⇄ p2p/hub                  │
  │  answers: projects.*, shells.*, fs.*,     │
  │           claude.*                        │
  └───────────────────────────────────────────┘
```

The serving half starts with the IDE and stops when the app quits.
Settings → P2P → **Serve this machine** (default on) toggles whether
the local instance accepts incoming sessions.

### Three concepts

- **Device** — one running metaIDE instance, with a MetaConnect
  agent token (reused) and a human-chosen name (`Laptop`, `Tower`).
- **Fleet** — the set of devices sharing one owner. Enforced by issuing
  all devices tokens scoped to the same MetaConnect user.
- **Session link** — a WebRTC data channel brokered through
  MetaConnect, with Noise XX layered on top (same reasoning as
  MetaRemote: belt and braces vs a hostile relay).

The IDE never speaks to MetaConnect for anything *except* starting a
session. Once ICE is done, data flows peer-to-peer (direct when
possible, through MetaConnect's TURN when NAT demands it).

---

## 4. Transport & identity — on top of MetaConnect

### 4.1 Reuse MetaConnect's agent identity

Each metaIDE / metaide-host instance already fits MetaConnect's agent
model: it dials out, authenticates with a token from `tokens.yaml`
(or the user console), and gets a stable logical identity (`machine
id`). We piggyback:

- `agent.token` → the shared secret with MetaConnect, stored at
  `~/.metaide/agent.token` (`0600`).
- `machine_id` → the human name shown in the Machines sidebar.
- The MetaConnect user that owns both tokens *is* the fleet. If
  tokens belong to the same user, their machines trust each other.

No new identity system. If MetaConnect later ships multi-user support
for a token (sharing within a team), metaIDE inherits team mode for
free.

### 4.2 One new signaling type: `TypeMetaIDE`

Mirror what MetaRemote did:

- In `metaconnect/internal/mrsignal/` (or its sibling): add
  `TypeMetaIDE` alongside `TypeMetaRemote`. Same wire schema; same
  `mrsession.Broker` policy (fail-closed authorize + mint token +
  route peers).
- In metaIDE: a Node client that speaks this frame type over the
  MetaConnect control connection (TCP+TLS, length-prefixed JSON — the
  same framing `mr-relay` already proved cross-stack).

The broker treats `TypeMetaIDE` sessions exactly like `TypeMetaRemote`
sessions: register ⇒ session_request ⇒ session_granted/session_invite
⇒ offer/answer/ICE. The only difference is the SDP: metaIDE
negotiates one SCTP data channel, no video/audio tracks.

> **Change required in MetaConnect:** add the new type and route it
> through `mrsession.Broker`. Documented in Appendix A. Estimated
> effort: ~1 day for a Go dev, parallel to this project.

### 4.3 WebRTC data channels

Electron ships Chromium → raw `RTCPeerConnection` with no extra
dependency. Both ends of a session are Electron processes, so both
sides use the same WebRTC API. No node-webrtc shim, no Rust host.
This is the main simplification from the "serve binary" alternative:
there is only one artefact to build, test, and ship.

### 4.4 Encryption

- WebRTC DTLS handles the data channel.
- A **Noise XX handshake**, keyed by per-device long-term public keys,
  runs before any RPC frame. Defeats a hostile relay doing SDP MitM
  (same rationale MetaRemote uses).
- Device public keys are exchanged during pairing (§4.5) and stored
  in `~/.metaide/known_devices.json`.

### 4.5 Pairing

Two routes:

- **Via MetaConnect console (preferred):** operator logs into the
  MetaConnect dashboard, creates a new agent token scoped to their
  user, runs the one-line install on the target box. On its first
  heartbeat, metaIDE's Machines panel surfaces it under the owner's
  fleet. No separate IDE-side pairing step.
- **Manual, no console:** on an existing paired device, Settings →
  P2P → **Pair a new machine** generates a short-lived enrollment
  code (5-min TTL). On the new box, `metaide-host enroll <code>`
  dials MetaConnect, exchanges device public keys over an
  authenticated channel, and persists the agent token.

QR for local pairing: fine, but post-v1.

---

## 5. The RPC protocol

Thin typed RPC over the data channel. Length-prefixed JSON for v1
(easy to debug; same framing MetaConnect and `mr-relay` already use),
with CBOR as a drop-in optimization later if PTY throughput complains.

### Frame

```ts
type Frame =
  | { kind: 'req'; id: number; method: string; params: any }
  | { kind: 'res'; id: number; ok: true; result: any }
  | { kind: 'res'; id: number; ok: false; error: { code: string; message: string } }
  | { kind: 'evt'; stream: number; data: any }
  | { kind: 'open-stream'; id: number; stream: number; method: string; params: any }
  | { kind: 'close-stream'; stream: number };
```

### Method catalogue (v1)

**Discovery**
- `device.info()` → `{ name, platform, version, uptime }`

**Projects**
- `projects.list()` → `Project[]` — same shape as the local SQLite row
- `projects.get(id)` → `Project`

**Shells (streaming)**
- `shells.list(projectId)` → `ShellInfo[]`
- `shells.attach(projectId, shellIndex)` → stream of
  `{ kind: 'out', bytes }` / `{ kind: 'exit', code }`;
  client sends `shells.input(stream, bytes)` and
  `shells.resize(stream, cols, rows)`
- `shells.launch(projectId, forceFirst?)` — same contract as local
  `shells:launch` IPC
- `shells.kill(projectId, shellIndex)`

**Filesystem**
- `fs.list(path)` → `Dirent[]`
- `fs.read(path)` → `{ content, encoding }` (text in v1; binary later)
- `fs.write(path, content, baseHash)` — baseHash guards against stale
  overwrites, returns `conflict` if the file changed since
- `fs.watch(path)` → coalesced change events

**Claude sessions**
- `claude.sessions.list(projectId)` → `.jsonl` files under
  `~/.claude/projects/<encoded>/`
- `claude.sessions.read(path, fromLine?)` → stream of session events
- `claude.repair(path)` → same as local `claude:repair-session`

### Permissions

Within a fleet, every method is allowed. v1 hard-codes owner-full-access
because every peer is the same human. The spot for later per-peer
scopes (`{ projects, fs, shells }`) is in `known_devices.json`
alongside the device public key.

---

## 6. UX

### New sidebar section: **Machines**

Sits above the project list. Each row:

```
  ⬤ Laptop  (this)
  ⬤ Tower   · 2 projects · 1 live shell
  ○ NAS     · offline — last seen 4h ago
```

- Expanding a machine shows its project list.
- Clicking a remote project opens it in a new pane *in the current
  window*. Pane header: `StarSkim @ Tower`, small P2P badge.
- Shell tabs under a remote project behave exactly like local ones;
  only visible difference is the P2P badge.
- Link drops ⇒ familiar overlay, worded `Reconnecting to Tower...`
  with a **Retry** button (same component as the existing Starting /
  Corrupted overlays).

### Settings → P2P

- Device name (editable)
- Device fingerprint (read-only, derived from public key)
- MetaConnect relay URL + token (read from `~/.metaide/agent.token`;
  edit opens the MetaConnect dashboard)
- Fleet members: list with revoke button (revokes the MetaConnect
  token for that machine)

### Serving mode

Every running metaIDE instance can serve. The serving half:

- Starts when Electron's main process has booted and the user's
  MetaConnect token has loaded.
- Registers with MetaConnect under this machine's name.
- Accepts incoming `TypeMetaIDE` session invites from fleet peers.
- Drains in-flight sessions and deregisters cleanly on `app.quit`.
- Can be toggled off per-machine in Settings → P2P → **Serve this
  machine** (persisted in the local SQLite).

**Deliberately out of scope for v1:** running metaIDE as a true
background service (no window, no Dock icon, launchd-managed). That's
`metaIDE --serve` headless mode, deferred to v2+ when the use case is
"a tower or NAS I never open the window on". For v1 the IDE must be
open (minimized is fine).

---

## 7. Data-model additions

New SQLite tables in `~/.metaide/metaide.db` (on the client side only;
the host persists almost nothing of its own, by design):

```sql
CREATE TABLE devices (
  id              TEXT PRIMARY KEY,           -- public key (hex)
  machine_id      TEXT NOT NULL,              -- MetaConnect machine id
  name            TEXT NOT NULL,
  last_seen_at    INTEGER,
  is_self         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE p2p_settings (
  relay_url       TEXT,                       -- defaults to the user's MetaConnect
  device_name     TEXT
);
```

No changes to the project/shell/claude-session tables — remote records
are fetched on demand and cached in memory per link.

---

## 8. Architecture: modules to add

All P2P code lives in-tree in the metaIDE repo. One artefact.

```
src/main/p2p/
  mcClient.ts       MetaConnect control-channel client (TLS TCP,
                    length-prefixed JSON, `TypeMetaIDE` frames)
  session.ts        Session FSM mirror of mr-core's SignalingSession
                    (register → request → granted/invite → offer/answer/ICE)
  transport.ts      RTCPeerConnection setup + Noise XX layer
  rpc.ts            Frame codec, request/response/stream plumbing
  hub.ts            Local RPC server: dispatches methods into the
                    existing src/main IPC handler internals
  pairing.ts        Enrollment code generation + verification
  index.ts          Boot + lifecycle (start on app ready, drain on quit)

src/renderer/p2p/
  useFleet.ts       React hook: machines + online status
  useRemoteProjects.ts
  remoteShellBridge.ts  Adapts remote shell stream to the ShellTab /
                        xterm plumbing (same event shape as local)

src/shared/p2p-contract.ts  Typed method/stream definitions
```

### Reusing existing IPC handlers (the key insight)

The main-process code that answers `shells:launch`, `shells:kill`,
`claude:repair-session`, `fs:list`, etc. is already a defined surface.
`p2p/hub.ts` is a thin adapter — when a remote peer calls
`shells.launch`, the hub invokes the same internal function the local
renderer's IPC call-site invokes. No duplication of business logic.

The renderer gets the mirror image: `ShellTab` doesn't know whether
its stream is local IPC or P2P; both emit the same event shape.

### Change in MetaConnect

```
metaconnect/internal/mrsignal/types.go
  + const TypeMetaIDE = "metaide"

metaconnect/internal/mrsession/
  - broker already generic; no code change needed, just wire the new
    type into cmd/mrsignald's route table.

metaconnect/cmd/mrsignald/routes.go
  + route TypeMetaIDE through the existing Broker
```

---

## 9. Latency, bandwidth, failure modes

### Latency budget

- LAN direct: WebRTC DTLS ~1–2 ms over TCP; feels local.
- WAN direct: dominated by RTT; target < 250 ms typing-feedback.
- TURN-relayed: adds relay RTT; UI flags > 400 ms.

### Bandwidth

- PTY output on a busy build: 1–2 MB/s burst. WebRTC data channels
  handle this; TURN-relayed path shows the "relayed" badge because
  bandwidth isn't free on the operator's VPS.
- Output coalescing on the host side (10 ms buffer) cuts packet rate
  without visible lag.

### What happens when...

- **Peer offline mid-shell:** stream closes; tab shows Reconnecting
  overlay. PTY on the remote machine keeps running (no SIGHUP).
  Reconnect ⇒ `shells.attach` resumes with the last 10 k lines of
  scrollback buffered on the host.
- **MetaConnect relay down:** can't start new sessions; existing
  sessions keep flowing (ICE already connected). Reconnect queue
  retries with jitter.
- **Device key lost:** owner revokes the machine's MetaConnect token
  (one click in the console); its public key is removed from every
  other machine's `known_devices.json`. Fresh install if the hardware
  is re-trusted.
- **Compromised device:** same revoke path. Short-lived "revoked"
  attestation propagates; peers refuse connections from revoked keys.

---

## 10. Security notes

- **Relay is untrusted for payload.** MetaConnect sees SDP and ICE
  candidates; Noise XX defeats SDP MitM. Same posture MetaRemote
  already runs with.
- **TLS on the signaling control connection.** MetaConnect already
  terminates TLS (Milestone G); we inherit it.
- **Ephemeral TURN credentials.** MetaConnect already issues per-session
  120 s creds (Milestone F); we inherit them.
- **Device compromise = fleet-wide access** in v1. Mitigation path
  (post-v1): per-peer scopes stored next to the public key.
- **Local attack surface.** The host binds nothing extra; it only dials
  out to MetaConnect. Install is launchd-managed, same hardening as
  `mr-host`.
- **Audit log.** Every incoming RPC written append-only to
  `~/.metaide/logs/p2p-audit.log`, rotated weekly. Visible in Settings
  → P2P → Audit.
- **Secrets never logged.** Agent token wrapped in a redacting Secret
  type (mirror the MetaRemote hardening item that's already parked).

---

## 11. Phasing

### v1 (ship first)

- MetaConnect: add `TypeMetaIDE` route (small Go change).
- Client+server transport in metaIDE: `mcClient`, `session`,
  `transport`, `rpc`, `hub`, `pairing`.
- Methods: `device.info`, `projects.list/get`, `shells.*`, `fs.list/read`.
- Machines sidebar + remote shell panes.
- Settings → P2P with "Serve this machine" toggle.

### v2

- `fs.write` with conflict detection + Monaco editor on remote files.
- `claude.sessions.*` with resume-on-another-device.
- Audit-log viewer UI.
- **Headless `metaIDE --serve` mode** for always-on boxes (no
  window, launchd/systemd-managed).

### v3

- Team mode: per-peer scopes.
- `fs.watch` + chosen-folder bidirectional sync (CRDT-friendly).
- "Follow my cursor" multi-pilot editor.

---

## 12. What's left to the builder

- Exact wire format: start JSON; swap to CBOR behind a feature flag
  if PTY throughput complains.
- Noise XX implementation: `@noble/ciphers` + `@noble/curves` for a
  hand-rolled XX, or `noise-handshake`. Prefer noble (audited, likely
  already a transitive dep).
- Enrollment-code wordlist: EFF Diceware short, length tunable.
- Scrollback buffer size on the serving side (default 10 k lines;
  expose as config).

Everything else is a decided call.

---

## 13. Decisions (approved 2026-10-27)

1. **One artefact: metaIDE itself is both client and server.** No
   separate `metaide-host` repo in v1. Every running IDE instance is
   reachable from fleet peers while it is running. Simpler install,
   simpler mental model, no shared-core extraction needed.
2. **Headless `metaIDE --serve` deferred to v2.** For v1 the IDE must
   be open (minimized is fine) on a machine to make it reachable.
3. **MetaConnect change ownership: separate PR in the metaconnect
   repo.** The `TypeMetaIDE` route addition (Appendix A) lands under
   the standard MetaConnect review flow, not from the metaIDE repo.
4. **Default relay URL:** `signal.metalogix.solutions` /
   `165.232.97.123` — the same MetaConnect instance MetaRemote
   already uses. Users can override in Settings → P2P.

---

## 14. Size

This is a **project**, not a small change.

- v1 scope above: ~2 weeks of focused work for one dev (dropped a
  week by removing the separate host product; MetaConnect +
  mrsession still do the signaling heavy work).
- Needs its own implementation plan (`superpowers:writing-plans`)
  before any code lands.
- The riskiest module is `transport.ts` (WebRTC + Noise on top of a
  TURN-routed connection). Worth a spike that just connects two
  Electron processes through the live MetaConnect relay and sends
  "hello", before writing the RPC layer.

---

## Appendix A — MetaConnect additions required

File-level deltas, in the `metaconnect` repo:

```
internal/mrsignal/types.go
  const (
      TypeMetaRemote = "metaremote"
      TypeMetaIDE    = "metaide"    // NEW
  )

cmd/mrsignald/routes.go
  // Register the new type with the broker. The broker itself is
  // type-agnostic (session_request / session_grant / offer / answer /
  // ice), so this is just a route-table entry.
  broker.Register(mrsignal.TypeMetaIDE, mrsession.NewHandler(
      policy.FailClosedOwnerFleet(),
      tokens,
      turnCreds,
  ))

internal/mrsession/
  // No change — the broker is generic.
```

A sibling test alongside the MetaRemote integration test:

```
internal/mrserver/metaide_integration_test.go
  // Two agents, same owner, exchange a session_request /
  // session_granted / offer / answer / ice over TypeMetaIDE and
  // report MEDIA_CONNECTED on both sides. (Same fixture pattern as
  // the existing MetaRemote end-to-end test.)
```

Estimated effort: ~1 day for a Go dev familiar with the mrsignal
codebase.

---

## Appendix B — Why not MetaRemote for everything

MetaRemote already streams screens and injects input. Why don't we
just use it for metaIDE?

- **Bandwidth:** streaming the whole desktop at 60 fps for what is
  really a shell session is wasteful. A PTY stream is kilobytes/s;
  H.265 at full res is megabytes/s.
- **Fidelity:** typing through a desktop stream has visible lag even
  on LAN; typing through a data channel feels instant.
- **Model:** MetaRemote has no concept of a Claude session file or a
  metaIDE project. metaIDE's power is in those objects — tunnelling
  pixels throws them away.
- **Composition:** both can run on the same host side-by-side. When
  the user wants to actually watch something graphical on the remote
  machine (a dev server UI, a chart), they open MetaRemote on it.
  When they want to drive a shell / edit code / resume Claude, they
  use metaIDE P2P. The two live together, keyed by the same
  MetaConnect account.
