// =====================================================================
// app.js — the UI. Renders main-process state; owns no truth of its own.
//
// The only local state is which topic is selected, because that is a property
// of this window rather than of the portal. Everything else (topics, files,
// connection) is whatever the last {type:'state'} said. One render function,
// called on every update — no incremental DOM patching to drift out of sync.
//
// This page runs sandboxed with no Node integration: `window.portal` is the
// entire world it can reach, and every function on it is listed in
// preload/index.cjs. There is no socket to reconnect and no token to carry —
// under Electron the channel to main cannot drop while the window is alive.
// =====================================================================

const $ = (id) => document.getElementById(id);

let state = { status:{}, topics:[], files:[], saveDir:'', maxBytes: 10*1024*1024 };
let selected = null;

// ── events from main ────────────────────────────────────────────────
window.portal.onEvent((m) => {
  if (m.type === 'state')  { state = m.state; render(); }
  if (m.type === 'status') { state.status = m.status; renderStatus(); }
  if (m.type === 'error')  toast(m.text, true);
  if (m.type === 'log' && m.level === 'error') toast(m.text, true);
  if (m.type === 'file' && m.file.dir === 'in') toast(`Received ${m.file.name}`);
  if (m.type === 'progress' && m.total) showBar(m.have / m.total);
});

/** Ask main to do something, and surface a refusal instead of swallowing it. */
async function ask(fn) {
  try { return await fn(); }
  catch (e) { toast(e.message, true); return null; }
}

// ── render ──────────────────────────────────────────────────────────
function renderStatus() {
  const s = state.status ?? {};
  if (s.error)          setDot('off', s.error);
  else if (s.connected) setDot('on', `${s.peers ?? 0} peers`);
  else                  setDot('', 'connecting…');
  $('kernel').textContent = s.kernel ? `kernel ${s.kernel}` : '';
}
function setDot(cls, text) {
  $('dot').className = `dot ${cls}`;
  $('statusText').textContent = text;
}

function render() {
  // topics — selection survives a re-render if the topic still exists
  if (selected && !state.topics.some(t => t.key === selected)) selected = null;
  if (!selected && state.topics.length === 1) selected = state.topics[0].key;

  const ul = $('topics');
  ul.replaceChildren(...state.topics.map(t => {
    const li = document.createElement('li');
    li.className = t.key === selected ? 'sel' : '';
    li.onclick = () => { selected = t.key; render(); };

    const name = document.createElement('span');
    name.className = 'name'; name.textContent = t.name;

    const tid = document.createElement('span');
    tid.className = 'tid'; tid.textContent = t.id ?? '(resolving…)';
    tid.title = 'Topic ID — share this with whoever should receive your files';

    const copy = document.createElement('button');
    copy.className = 'icon'; copy.type = 'button'; copy.textContent = 'copy'; copy.title = 'Copy topic ID';
    copy.onclick = (e) => {
      e.stopPropagation();
      if (t.id) navigator.clipboard.writeText(t.id).then(() => toast('Topic ID copied'));
    };

    const del = document.createElement('button');
    del.className = 'icon'; del.type = 'button'; del.textContent = '×'; del.title = 'Stop watching';
    del.onclick = (e) => { e.stopPropagation(); ask(() => window.portal.removeTopic(t.key)); };

    li.append(name, tid, copy, del);
    return li;
  }));

  // drop zone
  const drop = $('drop');
  const sel = state.topics.find(t => t.key === selected);
  drop.classList.toggle('disabled', !sel);
  $('dropSub').textContent = sel
    ? `to ${sel.name} · up to ${(state.maxBytes/1048576)|0} MB`
    : (state.topics.length ? 'Select a topic above' : 'Add a topic first');

  // files
  const fl = $('files');
  fl.replaceChildren(...state.files.map(f => {
    const li = document.createElement('li');

    const arrow = document.createElement('span');
    arrow.className = `arrow ${f.dir}`;
    arrow.textContent = f.dir === 'in' ? '↓' : '↑';
    arrow.title = f.dir === 'in' ? 'received' : 'sent';

    const name = document.createElement('button');
    name.className = 'fname' + (f.path ? ' click' : '');
    name.type = 'button';
    name.textContent = f.name;
    if (f.path) {
      name.title = 'Open with the default app';
      name.onclick = () => ask(() => window.portal.openFile(f.path));
      name.oncontextmenu = (e) => { e.preventDefault(); ask(() => window.portal.revealFile(f.path)); };
    } else {
      name.title = 'Sent from this machine';
    }

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${f.topic} · ${fmtSize(f.size)}`;

    li.append(arrow, name, meta);
    return li;
  }));
  $('filesEmpty').hidden = state.files.length > 0;
  $('saveDir').textContent = state.saveDir ?? '';
  renderStatus();
}

const fmtSize = (b) => b >= 1048576 ? `${(b/1048576).toFixed(1)} MB`
                     : b >= 1024    ? `${Math.round(b/1024)} KB` : `${b} B`;

// ── send a file ─────────────────────────────────────────────────────
async function upload(file) {
  const sel = state.topics.find(t => t.key === selected);
  if (!sel)  return toast('Select a topic first', true);
  if (file.size === 0)              return toast('That file is empty', true);
  if (file.size > state.maxBytes)   return toast(`${fmtSize(file.size)} is over the 10 MB limit`, true);

  showBar(0.05);
  try {
    // The page reads the bytes it was handed and passes them across; it never
    // passes a PATH. Main therefore has nothing to containment-check on the way
    // out, and the page cannot name a file the user did not drag in.
    const buffer = await file.arrayBuffer();
    await window.portal.sendFile({
      topicKey: selected, name: file.name,
      mime: file.type || 'application/octet-stream', buffer,
    });
    toast(`Sent ${file.name}`);
  } catch (e) { toast(e.message, true); }
  finally { hideBar(); }
}

function showBar(frac) { $('bar').hidden = false; $('barFill').style.width = `${Math.min(1, frac)*100}%`; }
function hideBar() { setTimeout(() => { $('bar').hidden = true; $('barFill').style.width = '0'; }, 400); }

let toastTimer = null;
function toast(text, warn = false) {
  const t = $('toast');
  t.textContent = text; t.className = `toast${warn ? ' warn' : ''}`; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, warn ? 6000 : 2800);
}

// ── wiring ──────────────────────────────────────────────────────────
$('addForm').onsubmit = (e) => {
  e.preventDefault();
  const v = $('topicInput').value.trim();
  if (v) { ask(() => window.portal.addTopic(v)); $('topicInput').value = ''; }
};
$('revealFolder').onclick = () => ask(() => window.portal.revealFolder());

const drop = $('drop');
drop.onclick = () => $('filePicker').click();
drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('filePicker').click(); } };
$('filePicker').onchange = (e) => { if (e.target.files[0]) upload(e.target.files[0]); e.target.value = ''; };

// Only the drop zone accepts a drop; the rest of the window rejects it, so a
// near-miss never navigates the page away to the dropped file.
for (const ev of ['dragenter','dragover','dragleave','drop']) {
  document.addEventListener(ev, (e) => { e.preventDefault(); }, false);
}
drop.addEventListener('dragover',  () => drop.classList.add('over'));
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  drop.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f) upload(f);            // one at a time: each file is its own transfer
});


// First paint. After this, everything arrives as an event.
ask(() => window.portal.getState()).then((st) => { if (st) { state = st; render(); } });
