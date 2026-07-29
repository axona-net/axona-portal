// =====================================================================
// server.js — the local half: static UI, an upload endpoint, a state socket.
//
// Bound to 127.0.0.1 ONLY. This process can read and write the save folder and
// can ask the OS to open files, so it is not something to expose on a LAN, and
// "it's just localhost" is not a reason to be careless: a page in the user's
// browser on any other origin can still POST here. Two guards:
//
//   · Origin check — every request must come from our own origin (or carry no
//     Origin at all, which is what curl and the WebSocket upgrade do).
//   · A per-run TOKEN in the URL the user is sent to. The UI echoes it back on
//     the socket and on upload. A random site cannot guess it, so it cannot
//     drive the portal even if the user visits it while the portal is running.
//
// The token is regenerated each run and never written to disk.
// =====================================================================

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MAX_FILE_BYTES, parseTopicInput, saveConfig } from './config.js';
import { launch } from './launch.js';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

export function startServer(portal, cfg) {
  const token = randomBytes(24).toString('hex');
  const clients = new Set();

  const emit = (ev) => {
    const s = JSON.stringify(ev);
    for (const ws of clients) { try { ws.send(s); } catch { /* */ } }
  };
  portal.emit = emit;

  const sameOrigin = (req) => {
    const o = req.headers.origin;
    if (!o) return true;                       // non-browser client; the token still gates it
    return o === `http://127.0.0.1:${cfg.port}` || o === `http://localhost:${cfg.port}`;
  };
  const authed = (url) => url.searchParams.get('t') === token;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${cfg.port}`);
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff' });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    if (!sameOrigin(req)) return send(403, { error: 'bad origin' });

    // ── static UI ────────────────────────────────────────────────────
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/ui/'))) {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(4);
      if (rel.includes('..')) return send(400, { error: 'no' });
      try {
        let body = await readFile(join(UI_DIR, rel));
        // replaceAll, and a placeholder that is not also an identifier in the
        // page — see the comment beside it in index.html.
        if (rel === 'index.html') body = Buffer.from(String(body).replaceAll('%%TOKEN%%', token));
        return send(200, body, MIME[extname(rel)] ?? 'application/octet-stream');
      } catch { return send(404, { error: 'not found' }); }
    }

    // ── upload: raw body, filename in a header ───────────────────────
    // Raw beats multipart here: no parser, no temp files, and the 10 MB cap is
    // enforced while the body streams rather than after it is all in memory.
    if (req.method === 'POST' && url.pathname === '/api/send') {
      if (!authed(url)) return send(403, { error: 'bad token' });
      const key  = url.searchParams.get('topic');
      const name = decodeURIComponent(req.headers['x-filename'] ?? 'file');
      const mime = String(req.headers['content-type'] ?? 'application/octet-stream');

      const declared = Number(req.headers['content-length'] ?? 0);
      if (declared > MAX_FILE_BYTES) return send(413, { error: `Over the 10 MB limit.` });

      const chunks = []; let total = 0, aborted = false;
      req.on('data', (c) => {
        total += c.length;
        if (total > MAX_FILE_BYTES) {           // a lying content-length must not win
          aborted = true; req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', async () => {
        if (aborted) return;
        try {
          const rec = await portal.send(key, { name, bytes: new Uint8Array(Buffer.concat(chunks)), mime });
          send(200, { ok: true, file: rec });
        } catch (e) { send(400, { error: e.message }); }
      });
      req.on('error', () => { if (!aborted) send(400, { error: 'upload failed' }); });
      return;
    }

    return send(404, { error: 'not found' });
  });

  // ── control socket ─────────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://127.0.0.1:${cfg.port}`);
    if (!sameOrigin(req) || !authed(url)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.send(JSON.stringify({ type: 'state', state: portal.state() }));
    ws.send(JSON.stringify({ type: 'status', status: portal.status }));

    ws.on('message', async (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      const fail = (text) => ws.send(JSON.stringify({ type: 'error', text }));
      try {
        switch (msg.type) {
          case 'addTopic': {
            const parsed = parseTopicInput(msg.value, cfg.region);
            await portal.addTopic(parsed);
            saveConfig(cfg);
            break;
          }
          case 'removeTopic':
            await portal.removeTopic(msg.key);
            saveConfig(cfg);
            break;
          case 'open':
          case 'reveal': {
            const r = launch(msg.type, msg.path, cfg.saveDir);
            if (!r.ok) fail(r.reason);
            break;
          }
          case 'revealFolder':
            launch('open', join(cfg.saveDir, '.'), dirname(cfg.saveDir));
            break;
          default: break;
        }
      } catch (e) { fail(e.message); }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 explicitly, NOT localhost: on a machine where localhost resolves
    // to ::1 first this is the difference between a reachable UI and a blank page.
    server.listen(cfg.port, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${cfg.port}/?t=${token}`, token });
    });
  });
}
