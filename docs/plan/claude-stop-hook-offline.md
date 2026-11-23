# Keep Claude hooks quiet when MetaLogix IDE is unavailable

## Summary

Replace IDE-injected HTTP hooks with a best-effort command forwarder for newly launched Claude Code sessions. Preserve notifications and Activity when the IDE receiver can authenticate the live session; do not turn a missing receiver into a Claude hook error.

The current runtime injects a per-port settings path. Claude retains the URL when the IDE closes, and a POST to a closed loopback listener reproduces `ECONNREFUSED`. The session registry exists only in memory, so an IDE restart does not authorize an old session, even if the forwarder finds the new port. Existing Claude processes that already loaded an HTTP hook may need to be resumed in a new process after upgrading.

## Security review

Use a per-instance private Unix socket or randomized Windows named pipe and keep the existing session ID and token verification. Do not persist bearer tokens, put them in command arguments, log them, or forward them to a stale or arbitrary listener. Bind a forwarder to the originating IDE instance and validate its endpoint before sending credentials. A new IDE instance must not accept an old hook session. Publish only owner-controlled rendezvous data, and make cleanup specific to the owning instance. Do not modify user or project Claude settings.

## Performance review

Hook events include frequent tool calls. Use one bounded, best-effort attempt with no retries; keep the timeout below Claude’s hook timeout and avoid adding a synchronous turn delay. Preserve event routing and test the active path as well as unavailable and slow paths. Use supported Windows and POSIX launch forms and verify the packaged runtime; do not assume a separate Node installation.

## Checklist

- [x] Read generated settings, launch decoration, runtime, verification registry, and the Claude command-hook contract.
- [x] Verify that closing a real loopback listener produces the reported connection refusal.
- [x] Add a regression that fails with the generated HTTP hook. Cover successful delivery, offline, refusal, timeout, and an old session after restart; prove that tokens and payloads do not reach an unrelated listener.
- [x] Implement the quiet command forwarder and owner-scoped endpoint lifecycle. It must not emit stdout/stderr or fail a Claude turn when the IDE is unavailable. Leave explicitly supplied `--settings` and non-Claude commands alone.
- [x] Confirm stale per-port cleanup cannot affect a running IDE or depend on guessing listener ownership. Leave older files alone if ownership cannot be established safely.
- [x] Verify current notification and Activity behavior with the packaged Electron/Claude fixture and exercise a saved hook after stopping its receiver. Document the migration and fresh-session behavior.
- [x] Run the focused hook and launch tests, the packaged smoke run, pinned TypeScript and lint, and full Vitest. Remove any diagnostic instrumentation.
