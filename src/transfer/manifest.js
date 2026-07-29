// =====================================================================
// manifest.js — the pointer that a file leaves on a shared topic.
//
// WHY CONTENT ADDRESSING (the defect this replaces). A topic's replay cache
// holds ~1024 messages and std/chunk splits a file into ~10752-byte pieces, so
// a 10 MB file is 977 messages. Sending it to a shared topic very nearly fills
// that topic's cache; the SECOND file evicts the first, and anyone who
// subscribes afterwards reassembles nothing — silently, because every chunk
// they DO receive is valid. The old design's "10 MB limit" was really a
// 10-MB-per-topic-forever limit.
//
// So the bytes go to a topic derived from their own hash, and only a small
// pointer lands on the shared topic. A shared topic now holds thousands of
// pointers instead of one file, each file gets a whole replay cache to itself,
// identical content dedupes to one address, and a single file can be retracted
// without touching anything else.
//
// THE POINTER IS THE CAPABILITY. Knowing the hash is knowing the address —
// there is no second permission check. Anyone who can read the shared topic can
// read every file announced on it. That is the same exposure the shared topic
// always had, but it is now explicit enough to say out loud.
// =====================================================================

import { createHash } from 'node:crypto';
import { TOPIC_PREFIX } from '../config.js';

/** Bumped when the shape changes. It is a wire format between independent
 *  implementations (a desktop portal and an MCP agent) the moment both exist. */
export const MANIFEST_V = 1;

/** Encodings a receiver must understand. `raw` is the bytes as given.
 *
 *  Deliberately NOT zipping in v1, though the original sketch said to: for a
 *  single file a container buys nothing (most shared files — images, video,
 *  pdf, archives — are already compressed, so it usually costs size), and zip
 *  output is not reproducible across implementations, which would break the
 *  "same bytes, same address" property that gives us dedup. The field exists so
 *  a container can be added for folder/multi-file drops without a wire break. */
export const ENCODINGS = new Set(['raw']);

/** sha256 of the ORIGINAL bytes, lowercase hex. This is the address. */
export function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The topic a file's bytes live on, derived from its content.
 *
 * Stays inside the `portal.` namespace like every other portal topic — the
 * collision that produced that namespace applies here too, and a bare 64-hex
 * name would additionally be mistaken for a topic ID by `parseTopicInput`.
 */
export function fileTopicName(sha256) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('fileTopicName: expected a lowercase 64-hex sha256');
  return `${TOPIC_PREFIX}f.${sha256}`;
}

/** Build the pointer that goes on the SHARED topic. Small by design. */
export function makePointer({ sha256, filename, bytes, mime = 'application/octet-stream', encoding = 'raw' }) {
  if (!/^[0-9a-f]{64}$/.test(sha256))       throw new Error('makePointer: bad sha256');
  if (!Number.isInteger(bytes) || bytes < 0) throw new Error('makePointer: bad bytes');
  if (!ENCODINGS.has(encoding))              throw new Error(`makePointer: unknown encoding ${encoding}`);
  return {
    v: MANIFEST_V,
    kind: 'file',
    sha256,
    filename: String(filename ?? 'file'),
    bytes,
    mime: String(mime),
    encoding,
  };
}

/**
 * Validate something that arrived from the network.
 *
 * Returns the pointer or `null` — never throws, never partially trusts. A
 * shared topic is public, so anything at all can land on it: other apps' std
 * messages, malformed junk, deliberate garbage. Callers get a clean yes/no
 * instead of a shape they have to re-check. Nothing here is trusted beyond
 * being well-formed; the sha256 is only proven once the bytes are in hand.
 */
export function readPointer(body) {
  if (!body || typeof body !== 'object')                 return null;
  if (body.v !== MANIFEST_V || body.kind !== 'file')     return null;
  if (!/^[0-9a-f]{64}$/.test(String(body.sha256 ?? ''))) return null;
  if (!Number.isInteger(body.bytes) || body.bytes < 0)   return null;
  if (!ENCODINGS.has(body.encoding))                     return null;
  return {
    v: body.v,
    kind: 'file',
    sha256: body.sha256,
    filename: String(body.filename ?? 'file'),
    bytes: body.bytes,
    mime: String(body.mime ?? 'application/octet-stream'),
    encoding: body.encoding,
  };
}
