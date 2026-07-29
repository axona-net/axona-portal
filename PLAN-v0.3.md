# axona.portal v0.3 — plan

*Written 2026-07-29. Proposal only; nothing here is built.*

## Where we actually are

| | state |
|---|---|
| `portal.` topic namespace | **DONE in v0.2.0** (`fc3fa3f`), fenced by 7 assertions in `smoke_config.mjs`. Not on this plan. |
| Repo | **local only — no git remote.** "Anyone with the repository can generate the app" is not true yet. |
| Kernel pin | **`v4.43.0` — stale.** Prod is 4.49.0. |
| Shape | Node process + localhost HTTP server + browser UI + per-run token. Works; is not an installable app. |
| Transfer engine | `src/portal.js` — kernel `std/chunk` (`publishChunkedBytes` / `createReassembler`) plus portal's own policy: safe filenames, containment, save dir, 10 MB ceiling. |

Two real items follow, and they are **not independent**: the MCP engine and the
desktop app should consume the same transfer module, so extracting it comes
first.

---

## Item A — extract the transfer engine (do this first)

Today the reusable part is entangled with the UI server. The chunking itself is
already kernel (`std/chunk`); what portal adds is the **policy layer**, and that
is exactly what MCP needs too:

- the `portal.` namespace and topic parsing (`config.js`)
- hostile-filename handling and save-path containment (`paths.js` — the whole
  trust boundary, 62 assertions)
- the file manifest: filename, bytes, sha256, mime
- launch safety (`isLaunchable`, `NO_LAUNCH`)

**Proposal: extract to `src/transfer/` inside this repo, and treat the *manifest
schema* — not the code — as the contract with MCP for now.** A shared npm package
is premature: #410 (content-addressed fan-out) will change the wire shape, and
publishing a package whose format is about to move is how you end up supporting
two. Ship the schema versioned (`v: 1`), let both sides implement it, extract to a
package once it stops moving.

**Fence:** the existing `smoke_paths.mjs` (62) and `smoke_config.mjs` (21) move
with the code and must stay green.

---

## Item B — installable desktop application

### Recommendation: Electron + electron-builder

| option | keeps Node code | `node-datachannel` | installers | effort |
|---|---|---|---|---|
| **Electron** | yes | yes — rebuild for Electron ABI | dmg · exe · AppImage | **medium — recommended** |
| Tauri | no, Rust backend | needs a Rust WebRTC stack or a Node sidecar | smallest | high (rewrite) |
| Node SEA / pkg | yes | native `.node` must ship beside the binary | crude | medium, poor UX |

Electron is not the fashionable answer; it is the correct one here, because the
hard dependency is a **native WebRTC module**. Tauri would mean either
reimplementing the peer in Rust or shipping a Node sidecar — at which point it is
Electron with extra steps.

### The part that is a genuine improvement, not just packaging

Today's architecture has a localhost HTTP server, a per-run token, and an Origin
check **because the UI is a browser**. Under Electron the renderer talks to the
main process over IPC:

- **no listening socket at all** — the entire "another site could drive it" class
  disappears rather than being defended against;
- no token to leak into a URL, no `%%TOKEN%%` substitution (which was already the
  source of one silent bug);
- `contextIsolation: true`, `nodeIntegration: false`, and a `preload` exposing a
  small explicit API — the UI cannot reach `fs` even if it wanted to.

`src/server.js` is deleted, not ported. That is a net reduction in attack surface
and roughly a third of the security-relevant code.

### Structure

```
main/        Electron main — owns the peer, the transfer engine, disk
  index.js     app lifecycle, single-instance lock, tray
  ipc.js       the ONLY main↔renderer surface, one handler per verb
preload/     contextBridge — exposes ~6 functions, nothing else
renderer/    today's ui/ almost unchanged (it already speaks a small API)
```

### The signing problem — and it is a decision, not a task

We already hit this: **macOS TCC denies an unsigned `.app` access to
`~/Documents`, `~/Desktop`, `~/Downloads`.** That is why `Axona Portal.command`
works and the bundle does not — Terminal already holds the permission.

An installable app that does not embarrass itself needs **Developer ID signing +
notarization**: ~$99/yr and, more importantly, **a legal identity attached to the
binary**. For a project whose thesis is a network with no owner, that is worth a
deliberate decision rather than an invoice. Options:

1. **Sign and notarize.** Best UX. Requires an Apple developer account in
   someone's name.
2. **Ship unsigned, document the right-click→Open dance**, and keep the save
   directory outside protected folders by default (`~/Axona Portal` already is).
   Free; the first-run experience is a scary dialog.
3. **Homebrew cask / winget.** Community-mediated distribution, still ultimately
   identity-bearing, but the identity is the tap not the binary.

I would ship **(2) plus a clear first-run explainer** for v0.3, and treat (1) as a
separate decision once there are enough users for the friction to matter. It
keeps the "clone it and build it yourself" property that makes the app match the
protocol.

---

## Item C — the MCP file engine

Goal: a human drops a file into portal and an agent can read it; an agent
produces a file and a human's portal receives it. Same `portal.` namespace on
both sides, so the two are genuinely the same network.

### Tools

| tool | behaviour |
|---|---|
| `axona_send_file(path, topic)` | chunk + publish. Returns `{sha256, bytes, filename, topicId, msgId}`. |
| `axona_list_files(topic)` | what has been announced on the topic — filename, size, hash, sender, time. **Reads only.** |
| `axona_get_file(hash, savePath?)` | fetch, reassemble, **verify sha256**, then write. Refuses on mismatch. |

### The security shape matters more than the tools

Portal auto-saves arrivals; that is defensible for a desktop app the user is
watching. **For MCP it is not.** A topic is public — anyone who knows it can
publish to it — so auto-saving would mean *any stranger can put bytes on the
agent's host* by publishing to a watched topic.

**Therefore: MCP is pull-only.** Arrivals are *listed*; nothing touches disk until
an explicit `axona_get_file`. Plus:

- reuse `paths.js` containment verbatim — filenames from the network are hostile
  text, reduced to one component, control characters stripped, never escaping the
  save root;
- write `0600`, no execute bit, never auto-open, and keep the `NO_LAUNCH` set;
- **verify sha256 before writing**, not after — a manifest that does not match its
  bytes is a refusal, not a warning;
- per-topic size and count quotas, so a hostile publisher cannot fill a disk;
- the save root is a configured directory, never a caller-supplied absolute path.

### Sequencing note

**#410 (content-addressed fan-out) should land before MCP, not after.** A topic's
replay cache holds ~1024 messages and a 10 MB file is 977 of them — so one
max-size file nearly fills a shared topic and the second evicts the first. With a
human portal *and* an agent both using `portal.axona.bot`, that ceiling arrives
immediately. Content addressing (file → its own hash-derived topic, a small
pointer on the shared topic) removes it and gives dedup and per-file retract for
free.

---

## Enhancements worth doing, roughly in value order

1. **#410 content-addressed fan-out** — prerequisite for C, described above.
2. **Encryption to a recipient author key.** Today a portal transfer is plaintext
   on a public topic; the README says so honestly, but "share a file with an
   agent" makes it much more pointed. X25519 to the recipient's author key, with
   the pointer carrying the key id. *Note the open question from
   `research_axona_chat_review`: encrypt-to-author using a public authorId as a
   key is theatre. This needs real key exchange or it should stay off.*
3. **Manifest v1**, versioned from the start: `{v, filename, bytes, sha256, mime,
   createdAt}`. It is a wire format between independent implementations the moment
   MCP exists.
4. **Progress and repair visibility.** `std/chunk` already verifies and repairs;
   surface chunks-outstanding so a stalled transfer is legible instead of just
   slow.
5. **#407 retract** — keep msgIds so a transfer can be withdrawn. Much cheaper
   once each file owns a topic.
6. **#408 warn on a topic that already carries chat traffic** — the near-miss that
   produced the `portal.` namespace in the first place.
7. **Kernel pin 4.43.0 → 4.49.0** and add `check_kernel_pin.mjs` to `npm test`,
   matching bridge/chat/share. The lockfile trap has bitten four times.
8. **Push the repo to `axona-net/axona-portal`.** "Anyone with the repository can
   generate the app" is currently false.
9. **Folder and multi-file drops** — natural once a zip is in the path for #410.

---

## Proposed order

```
0.  kernel pin → 4.49.0 + pin fence + push repo to GitHub      (hygiene, ~1h)
1.  #410 content-addressed fan-out + manifest v1               (unblocks everything)
2.  Item A — extract src/transfer/, fences move with it
3.  Item C — MCP tools, pull-only, on the extracted engine
4.  Item B — Electron shell; delete server.js and the token
5.  #407 retract · #408 chat-topic warning · progress surface
6.  encryption — only with real key exchange, else leave it off and keep saying so
```

Rationale for putting the Electron work **last** among the substantive items:
it is the change with the least protocol risk and the most yak-shaving (icons,
installers, notarization dialogs). Doing it after the engine is extracted means
the shell wraps a stable core instead of being rebuilt around a moving one.

---

## Decisions needed from David

1. **Electron** — agreed, or is a smaller binary worth a Rust rewrite?
2. **Signing:** unsigned with a first-run explainer (my recommendation for v0.3),
   or buy the Developer ID now and accept a named identity on the binary?
3. **MCP pull-only** — agreed? It means an agent never auto-receives, which is
   slightly less magical and considerably safer.
4. **Encryption:** leave off with an honest README until real key exchange exists,
   or block file-sharing-with-agents on building it?
5. **Repo home:** `axona-net/axona-portal` public from the start?
