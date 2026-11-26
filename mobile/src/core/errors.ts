import { Schema } from 'effect';

/**
 * A link to a desktop could not be opened or was lost. `reason` is the short code the relay, the desktop
 * or this layer gave (`relay_unreachable`, `handshake_failed`, `untrusted_device`, ...); the UI turns it
 * into words.
 */
export class LinkError extends Schema.TaggedError<LinkError>()('LinkError', {
  reason: Schema.String,
}) {}

/** A request the desktop refused, or one that got no answer (`request_timeout`, `closed`). */
export class RpcError extends Schema.TaggedError<RpcError>()('RpcError', {
  code: Schema.String,
  message: Schema.String,
}) {}
