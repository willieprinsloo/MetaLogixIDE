# MetaLogix IDE mobile

A phone companion for MetaLogix IDE, built with React Native (Expo). It pairs with your
desktops and shows what they are working on.

- **Swipe left and right** to move between paired machines, one page each.
- Each page lists that machine's **active projects**: the ones with a shell running, with the
  agent's state (Working, Needs input, Idle).
- **Tap a project** to open its terminal. The desktop replays the screen, then streams it live.
  Projects with several shells get a tab per shell, named as on the desktop (Claude, opencode, Terminal). A key bar adds esc, tab, ctrl, arrows and ^C.
- **Dictate** with the 🎤 key. Your words appear in a box you can correct; nothing reaches the
  shell until you tap Insert or Send.

## How it connects

The phone is a paired, viewer-only device on the same P2P fleet as the desktops. Nothing
changes on the desktop side.

```
TCP relay (mrsignald) → WebRTC data channel → Noise XX → RPC (projects.list, shells.alive, shells.attach …)
```

`src/core` is a port of the viewer half of `src/main/p2p` with no React Native imports. It is
written with [Effect](https://effect.website) (v4):

- **Services.** The platform is four services (`Relay`, `Peers`, `Storage`, `Platform`, in
  `services.ts`). React Native provides them as one Layer in `src/platform`; the tests provide
  in-memory ones.
- **Typed failures.** A link fails with `LinkError { reason }`, a request with
  `RpcError { code }`. Nothing in the core throws.
- **Schemas.** Everything from outside (relay envelopes, RPC frames and results, storage, the
  pairing link) is decoded with `Schema` in `schemas.ts`.
- **Scopes.** A connection owns its relay socket and peer connection through a `Scope`. Each
  machine has one supervisor fiber that connects, polls and reconnects; interrupting it closes
  the link.
- **The edge.** `Fleet` runs those effects on a `ManagedRuntime` and exposes a plain
  `subscribe`/`getSnapshot` store, so React components need no Effect.

The interop tests run the core against the desktop's own Noise, RPC and pairing code:

```bash
npm test          # from mobile/, or `pnpm test mobile/src/core` from the repo root
```

| Path | What it holds |
| --- | --- |
| `src/core` | Errors, schemas, services, Noise handshake, secure channel, RPC client, link setup, fleet state |
| `src/platform` | The React Native Layer: TCP socket, WebRTC peer, keychain and storage |
| `src/terminal` | The terminal page (xterm.js) and its typed message protocol with the app |
| `src/ui` | Fleet pager, pairing screen, terminal screen |
| `scripts` | `build-terminal-html.mts` bundles the terminal page; `probe.mts` replays the phone's connection from a computer |

The device key lives in the keychain (Keystore on Android). Paired machines and relay settings
live in app storage.

## Run it

The app uses native modules (TCP sockets, WebRTC), so it needs a development build. Expo Go
will not run it.

```bash
cd mobile
npm install
npm run ios        # or: npm run android
```

To run on a real iPhone, open `ios/MetaLogixIDE.xcworkspace` in Xcode once to pick a signing
team, or pass `--device` to `npx expo run:ios`.

## Pair a machine

1. On the desktop: Settings → P2P → **Pair a new machine**. Keep the window open.
2. On the phone: tap **＋**, then **Scan QR code** and point the camera at the desktop. Or type
   the pair code and tap **Pair**.

The QR code holds `metaide://pair?code=…&relay=…&port=…`, so the phone also picks up the
desktop's relay. Scanning in the app pairs at once. The same link opened from outside the app
(the system camera, a message) only fills in the form: you still tap Pair.

The phone then appears under Settings → P2P on the desktop, marked "viewer only". It is not a
fleet machine: desktops never show it in the sidebar or Fleet view. To unpair, long-press the machine name
on the phone and remove the phone under Settings → P2P on the desktop.

## Good to know

- Opening a terminal resizes that shell to fit the phone, as any remote viewer does. The
  desktop sizes it back when you use it there.
- The relay defaults to `remote.metalogix.solutions:7100`. Change it under **Relay** on the
  pairing screen if your desktops use their own `mrsignald`.
- iOS suspends the app in the background. Links are rebuilt when you return.
