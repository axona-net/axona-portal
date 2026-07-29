# axona.portal

Drag a file in. It arrives on someone else's desktop.

A small desktop app that runs on your own machine. You give it one or more **topics**;
anything you drop is chunked, signed and published. Anything anyone else publishes to
a topic you watch is fetched, verified, saved to a folder, and listed. Click it to
open it.

No account, no server of ours holding your files, no upload page. The bridge is used
to find peers and then gets out of the way — once the mesh forms, transfers go
peer-to-peer.

```bash
git clone https://github.com/axona-net/axona-portal
cd axona-portal
npm install
npm start
```

That's the app. To build an installer for your platform:

```bash
npm run dist
```

`dmg` on macOS, `nsis` on Windows, `AppImage` on Linux, in `dist/`.

## About unsigned builds

The app carries no Developer ID, so macOS and Windows will say its publisher is
unknown. **That warning is accurate** — and it is the same one you would get from a
build you made yourself. On macOS the first launch needs a right-click → Open.

Signing costs $99/yr and, more to the point, attaches a legal identity to the binary.
For a project whose whole claim is a network with no owner, that is a decision worth
taking deliberately rather than by invoice, so for now the answer is: build it
yourself, or accept the dialog. Received files are saved to `~/Axona Portal`, which is
outside the folders macOS protects, so the app never needs a permission it can't get.

---

## Using it

**Add a topic.** Type a name — `design-team` — and press Add. The portal shows the
topic's **ID**, a 66-character string. That ID is the address. Give it to whoever
should receive your files; they paste it into their own portal and press Add. Both
of you are now on the same topic.

A name and an ID are two ways of saying the same thing: `portal.design-team` in
region `eagle` always derives the same ID, for everyone. Sharing the name works
just as well as sharing the ID, as long as you both use the same region.

**Every name you type goes under `portal.`** — type `design-team`, get
`portal.design-team`. A topic name is a *global* address, and the obvious name for
a thing is the name someone else already used: typing `axona.bot` here once derived
exactly the address a chat channel uses by that name, which is one plausible word
away from publishing a few hundred file chunks into somebody's conversation.
Nothing was broken and nothing warned — it is one flat namespace and both sides
addressed it correctly. The prefix makes that collision impossible rather than
unlikely, and it is shown in full so the address you share is the address you see.

A pasted 66-character topic **ID** is exempt: an ID is already a resolved address,
and typing 66 hex characters is not a slip. That's the escape hatch when you really
do mean one specific topic.

**Send.** Select a topic, drop a file. Up to 10 MB.

**Receive.** Files arrive on their own, save to `~/Axona Portal`, and appear in the
list. Click to open with your default app; right-click to reveal it in the folder
instead.

**Sharing with an agent.** The MCP file tools in
[`axona-relay`](https://github.com/axona-net/axona-relay) speak the same format on
the same `portal.` namespace, so an agent can list and fetch what you drop here, and
you receive what it sends. The agent side is deliberately **pull-only** — it never
writes a file to disk without being asked for that specific one by hash.

---

## How a file is addressed

A file's bytes go to a topic derived from **their own sha256**, and only a small
pointer lands on the topic you share:

```
bytes   ──chunked──>  portal.f.<sha256>       its own topic, ~977 messages for 10 MB
pointer ─────────->   portal.design-team      a few hundred bytes
```

This is not decoration. A topic's replay cache holds about 1024 messages and a 10 MB
file is 977 of them, so putting bytes directly on a shared topic means the *second*
file silently evicts the first — no error, the file is just not there any more. With
pointers the shared topic is an index and holds thousands of entries.

The hash is both the address and the integrity check. A receiver recomputes it over
whatever reassembled and **refuses to write on a mismatch**, so it does not have to
trust the sender, the pointer, or the network — only arithmetic. Identical content
sent twice is one file, and a re-send costs nothing.

---

## What to know before you share something

**A topic is public.** Anyone who knows the topic ID can read everything published
to it, and can publish to it. There is no membership list and no invitation. Choose
a name nobody would guess (`design-team-7f3a91c4` rather than `design-team`), or
treat the topic as public and only send things you would be comfortable seeing
elsewhere. This app does not encrypt file contents.

**Publishes are signed but the author is fresh each run.** Every message carries a
signature, so a file cannot be altered in flight without detection. The signing
identity is minted anew on each start, so "the same sender as last time" is not
something the app can currently show you.

**Files are inert on arrival.** Anything received is written with permissions `0600`
and no execute bit, whatever the sender named it. The portal will not hand an
executable (`.exe`, `.app`, `.sh`, `.command`, …) to your operating system's
launcher; for those it offers Reveal instead, so the decision to run something a
stranger sent is yours and is taken in the OS, not on a click in this app.

Filenames from the network are treated as hostile text: reduced to a single
component, stripped of control characters, never allowed to escape the save folder.
That logic lives in [`src/paths.js`](src/paths.js) and is the app's whole trust
boundary; [`test/smoke_paths.mjs`](test/smoke_paths.mjs) asserts it.

**There is no listening socket.** Earlier versions ran a localhost HTTP server for a
browser UI, defended with an Origin check and a per-run token. Under Electron the
window talks to the app over IPC, so that whole class — "another page in your browser
could drive this" — is gone rather than guarded against. The renderer runs sandboxed
with no Node integration and can reach exactly the seven functions in
[`preload/index.cjs`](preload/index.cjs).

---

## Why 10 MB

Not a preference — the protocol's shape, as above. `std/chunk` splits a file into
~10.7 KB messages and the replay cache holds about 1024. Content addressing means a
shared topic no longer fills up, but a *single* file still has to fit in one topic's
cache to stay reassemblable by a later subscriber. 10 MB is 977 messages; the true
wall is around 10.4 MB.

`test/smoke_config.mjs` checks the limit against the kernel's own chunk size, so if
the kernel ever changes it, the test fails before a user does.

---

## Configuration

`~/.axona-portal/config.json` — topics, save folder, bridge, region. Nothing
key-shaped is stored there; the transport identity is minted fresh every run and is
never written to disk.

`~/.axona-portal/received.json` — a ledger of sha256s already saved, so a restart
does not re-download and re-save the whole backlog of every topic you watch. Delete a
received file and the portal will *not* fetch it again; remove its entry here if you
want it back.

| Variable | Default | |
|---|---|---|
| `AXONA_BRIDGE` | `wss://bridge.axona.net` | e.g. `wss://testnet.axona.net` |

---

## How it fits together

```
main/index.js     app lifecycle, the window, the peer, single-instance lock
main/ipc.js       the ONLY main<->renderer surface — the trust boundary
preload/index.cjs contextBridge; seven functions, nothing else
renderer/         plain HTML/CSS/JS, no build step, no framework, sandboxed
src/portal.js     one peer; one standing pointer subscription per topic
src/transfer/     content addressing — sendFile / watchPointers / fetchBytes
src/paths.js      remote filename -> local path
src/launch.js     hand a file to the OS, carefully
src/received.js   what has already been saved
```

`src/transfer/` implements manifest v1, which `axona-relay/src/file-transfer.js`
implements **separately**. The schema is the contract, not the code — they are not one
package yet because the format is still young. Both sides are fenced against drift,
and `scripts/live-app-interop.mjs` proves it over the production network by making a
real `Portal` trade files with the agent implementation.

Built on [`@axona/protocol`](https://github.com/axona-net/axona-protocol).

```bash
npm test                              # trust boundary, manifest, IPC surface, kernel pin
node scripts/live-app-interop.mjs     # app <-> agent, over the real network
```

---

## Anyone can run this

Clone, `npm install`, `npm start`. The only native dependency is `node-datachannel`,
which ships prebuilt N-API binaries — ABI-stable across Node and Electron, so there is
no rebuild step. Node 20 or newer.

MIT.
