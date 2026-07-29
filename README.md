# axona.portal

Drag a file in. It arrives on someone else's desktop.

A small Node app that runs on your own machine. You give it one or more **topics**;
anything you drop is chunked, signed and published to the topic you picked. Anything
anyone else publishes to a topic you watch is reassembled, saved to a folder, and
listed. Click it to open it.

No account, no server of ours holding your files, no upload page. The bridge is used
to find peers and then gets out of the way — once the mesh forms, transfers go
peer-to-peer.

```bash
git clone https://github.com/axona-net/axona-portal
cd axona-portal
npm install
npm start
```

A browser window opens at `http://127.0.0.1:7777`. That's the app.

---

## Using it

**Add a topic.** Type a name — `design-team` — and press Add. The portal shows the
topic's **ID**, a 66-character string. That ID is the address. Give it to whoever
should receive your files; they paste it into their own portal and press Add. Both
of you are now on the same topic.

A name and an ID are two ways of saying the same thing: `design-team` in region
`eagle` always derives the same ID, for everyone. Sharing the name works just as
well as sharing the ID, as long as you both use the same region.

**Send.** Select a topic, drop a file. Up to 10 MB.

**Receive.** Files arrive on their own, save to `~/Axona Portal`, and appear in the
list. Click to open with your default app; right-click to reveal it in the folder
instead.

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

**The local server is bound to `127.0.0.1`** and gated by a random token, regenerated
each run and printed in the URL. Another site open in your browser cannot drive it.

---

## Why 10 MB

Not a preference — the protocol's shape. `std/chunk` splits a file into ~10.7 KB
messages, and a topic's replay cache holds about 1024 of them. A transfer bigger
than that cache cannot be reassembled by anyone who subscribes *after* it was sent:
the mesh no longer holds every piece. 10 MB is 977 messages, comfortably inside the
ceiling. The true wall is around 10.4 MB.

`test/smoke_config.mjs` checks the limit against the kernel's own chunk size, so if
the kernel ever changes it, the test fails before a user does.

---

## Configuration

`~/.axona-portal/config.json` — topics, save folder, bridge, port. Nothing
key-shaped is stored there.

| Variable | Default | |
|---|---|---|
| `AXONA_PORT` | `7777` | if the port is taken |
| `AXONA_BRIDGE` | `wss://bridge.axona.net` | e.g. `wss://testnet.axona.net` |
| `AXONA_NO_OPEN` | — | set to skip launching a browser |

---

## How it fits together

```
ui/            plain HTML/CSS/JS, no build step, no framework
src/index.js   start config -> peer -> server -> browser
src/portal.js  one peer; one persistent subscription + reassembler PER TOPIC
src/server.js  127.0.0.1 static + upload + state socket
src/paths.js   the trust boundary (remote filename -> local path)
src/launch.js  hand a file to the OS, carefully
```

A topic is a *stream* of files over time, so each watched topic keeps a standing
subscription and its own reassembler rather than waiting for one file and stopping.

Built on [`@axona/protocol`](https://github.com/axona-net/axona-protocol) — the
`std/chunk` helpers do the chunking, publish-verify-repair, and reassembly.

```bash
npm test    # trust boundary, topic parsing, size ceiling, kernel pin
```

---

## Anyone can run this

There is no build and no signing step. Clone, `npm install`, `npm start`. The only
native dependency is `node-datachannel`, which ships prebuilt binaries for macOS,
Linux and Windows. Node 20 or newer.

MIT.
