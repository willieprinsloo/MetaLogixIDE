# MetaLogix IDE mobile

A phone companion for MetaLogix IDE, built with React Native (Expo). It pairs with your
desktops and shows what they are working on.

- **Swipe left and right** to move between paired machines, one page each.
- Each page lists that machine's **active projects**: the ones with a shell running, with the
  agent's state (Working, Needs input, Idle).
- **Tap a project** to open its terminal. The desktop replays the screen, then streams it live.
  Projects with several shells get a tab per shell, named as on the desktop (Claude, opencode, Terminal). A key bar adds esc, tab, ctrl, arrows and ^C.

## How it connects

The phone is a paired, viewer-only device on the same P2P fleet as the desktops. Nothing
changes on the desktop side.

```
TCP relay (mrsignald) → WebRTC data channel → Noise XX → RPC (projects.list, shells.alive, shells.attach …)
```

`src/core` is a port of the viewer half of `src/main/p2p` with no React Native imports. The
socket and the peer connection are injected, so the interop tests run it against the desktop's
own Noise, RPC and pairing code:

```bash
npm test          # from mobile/, or `pnpm test mobile/src/core` from the repo root
```

| Path | What it holds |
| --- | --- |
| `src/core` | Wire framing, Noise handshake, secure channel, RPC client, link setup, fleet state |
| `src/platform` | React Native pieces: TCP socket, WebRTC peer, keychain and storage |
| `src/ui` | Fleet pager, pairing screen, terminal (xterm.js in a WebView) |

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
2. On the phone: tap **＋**, enter the pair code, tap **Pair**.

The phone then appears under Settings → P2P on the desktop, marked "viewer only". It is not a
fleet machine: desktops never show it in the sidebar or Fleet view. To unpair, long-press the machine name
on the phone and remove the phone under Settings → P2P on the desktop.

## Good to know

- Opening a terminal resizes that shell to fit the phone, as any remote viewer does. The
  desktop sizes it back when you use it there.
- The relay defaults to `remote.metalogix.solutions:7100`. Change it under **Relay** on the
  pairing screen if your desktops use their own `mrsignald`.
- iOS suspends the app in the background. Links are rebuilt when you return.
