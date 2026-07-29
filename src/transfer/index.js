// =====================================================================
// transfer/ — send and fetch a file over Axona, content-addressed.
//
// The shape, and why it is two topics rather than one:
//
//   bytes  ──chunked──>  portal.f.<sha256>     a topic of the file's own
//   pointer ─────────->  portal.<shared name>  a few hundred bytes
//
// A receiver reads pointers off the shared topic (cheap, and nothing touches
// disk), then fetches the bytes of the one it wants by their hash. The hash is
// both the address and the integrity check, so a fetch that reassembles to the
// wrong bytes is a REFUSAL, not a warning — see fetchBytes.
//
// This module is deliberately free of disk and UI: it takes and returns bytes.
// Anything that writes to a filesystem goes through paths.js, which is the
// trust boundary, and lives at the caller. That separation is what lets the
// same engine serve the desktop app (which auto-saves for a watching human) and
// the MCP tools (which must NOT — a shared topic is public, so auto-saving
// would let any stranger put bytes on an agent's host).
// =====================================================================

import { publishChunkedBytes, receiveChunkedBytes } from '@axona/protocol/std/chunk.js';
import { hashBytes, fileTopicName, makePointer, readPointer } from './manifest.js';

export { hashBytes, fileTopicName, makePointer, readPointer, MANIFEST_V } from './manifest.js';

/** Fetches wait this long for every chunk of a file before giving up. */
export const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

/**
 * Publish a file: bytes to their own hash-derived topic, pointer to the shared one.
 *
 * Order matters. The bytes go first and `publishChunkedBytes` verifies and
 * repairs them before we return; only then is the pointer announced. A pointer
 * that arrives before its bytes are cached is an invitation to a fetch that
 * times out, which reads to a user as "the network lost my file".
 */
export async function sendFile(peer, {
  bytes, filename, mime = 'application/octet-stream',
  shareTopic, region, signWith, onProgress = null,
}) {
  if (!(bytes instanceof Uint8Array)) throw new Error('sendFile: bytes must be a Uint8Array');
  if (!shareTopic)                    throw new Error('sendFile: shareTopic is required');

  const sha256    = hashBytes(bytes);
  const fileTopic = { region, name: fileTopicName(sha256) };

  const res = await publishChunkedBytes(peer, bytes, {
    topic: fileTopic, signWith, name: filename, mime, onProgress,
  });

  const pointer = makePointer({ sha256, filename, bytes: bytes.length, mime, encoding: 'raw' });
  const pointerMsgId = await peer.pub(shareTopic, pointer, { signWith });

  return {
    sha256, pointer, pointerMsgId,
    fileTopic,
    chunks:   res?.n ?? null,
    repaired: res?.repaired ?? 0,
    fileMsgIds: res?.msgIds ?? [],       // kept so a transfer can be retracted (#407)
  };
}

/**
 * Watch a shared topic for file pointers. **Reads only — never touches disk.**
 *
 * Junk is expected, not exceptional: a shared topic is public and other apps
 * publish their own shapes to topics all the time. `readPointer` returns null
 * for anything that is not a well-formed v1 pointer and we drop it silently
 * rather than logging noise for every chat message that happens by.
 *
 * Returns the subscription handle so the caller can stop it.
 */
export async function watchPointers(peer, shareTopic, onPointer, { since = 'all' } = {}) {
  return peer.sub(shareTopic, (env) => {
    const p = readPointer(env?.message);
    if (!p) return;
    onPointer({
      ...p,
      msgId:  env.msgId,
      signer: env.signerPubkey ?? null,
      ts:     env.ts ?? null,
    });
  }, { since });
}

/**
 * Fetch a file by its hash and return the bytes — **verified**.
 *
 * The sha256 is recomputed over what actually reassembled and compared to what
 * was asked for. A mismatch throws. This is the whole reason content addressing
 * is worth the extra topic: the receiver does not have to trust the sender, the
 * pointer, or the network — only arithmetic. Callers may therefore write the
 * result to disk knowing it is the file that was named, and MUST NOT write
 * anything this function did not return.
 */
export async function fetchBytes(peer, {
  sha256, region, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, onProgress = null,
}) {
  if (!/^[0-9a-f]{64}$/.test(String(sha256 ?? ''))) throw new Error('fetchBytes: expected a lowercase 64-hex sha256');

  const fileTopic = { region, name: fileTopicName(sha256) };
  const file = await receiveChunkedBytes(peer, fileTopic, { timeoutMs, onProgress });

  const got = hashBytes(file.bytes);
  if (got !== sha256) {
    throw new Error(
      `fetchBytes: content does not match its address — asked for ${sha256.slice(0, 12)}…, ` +
      `reassembled ${got.slice(0, 12)}… (${file.bytes.length} bytes). Refusing.`);
  }

  return {
    bytes:    file.bytes,
    sha256,
    filename: file.name ?? 'file',
    mime:     file.mime ?? 'application/octet-stream',
    msgIds:   file.msgIds ?? [],
  };
}
