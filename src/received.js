// =====================================================================
// received.js — remember which files have already been saved.
//
// This exists because of `since: 'all'`. A watched topic replays its whole
// backlog every time the portal starts, so without a memory of what has already
// landed, every restart re-fetches every historical file and writes it again as
// "report (2).pdf", "report (3).pdf"… The bug is invisible on day one and
// obvious after a week.
//
// Content addressing makes the memory exact rather than heuristic: the key is
// the sha256 of the bytes, so "have I already got this?" is a question with a
// right answer, not a guess based on filename and size.
//
// Consequence worth stating plainly: if you DELETE a received file, the portal
// will not fetch it again — it still believes it has it. There is no re-fetch
// in the UI yet; the honest workaround is to remove the entry from this file.
// =====================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.js';

export const RECEIVED_FILE = join(CONFIG_DIR, 'received.json');

/** Keep the newest N. A ledger that grows forever is a slow leak, and the old
 *  end of it stops being useful once the file is long gone from the topic. */
export const MAX_ENTRIES = 500;

export function loadReceived() {
  if (!existsSync(RECEIVED_FILE)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(RECEIVED_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return new Map();
    // Only well-formed entries survive a reload. A corrupt ledger must degrade
    // to "I have not seen this" — which re-downloads a file — never to a crash
    // that stops the portal from starting.
    return new Map(Object.entries(raw)
      .filter(([k, v]) => /^[0-9a-f]{64}$/.test(k) && v && typeof v === 'object')
      .map(([k, v]) => [k, { name: String(v.name ?? 'file'), at: Number(v.at) || 0 }]));
  } catch { return new Map(); }
}

export function saveReceived(map) {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const newest = [...map.entries()].sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, MAX_ENTRIES);
    writeFileSync(RECEIVED_FILE, JSON.stringify(Object.fromEntries(newest), null, 2) + '\n', { mode: 0o600 });
  } catch { /* the ledger is an optimisation; never block a save on writing it */ }
}
