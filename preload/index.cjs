// =====================================================================
// preload/index.cjs — the whole API the page is allowed to have.
//
// CommonJS, deliberately: an ESM preload requires sandbox:false, and the
// sandbox is worth more than the syntax.
//
// contextBridge copies these functions into the page's world through a
// structured-clone boundary. The page cannot reach ipcRenderer, cannot invent a
// channel name, and cannot pass a function or a live object through — only
// plain data crosses. So this file is the complete list of things a compromised
// renderer could do, and it is seven verbs long.
// =====================================================================

const { contextBridge, ipcRenderer } = require('electron');

/** Unwrap main's {ok, value|error} envelope into a normal promise, so the page
 *  writes ordinary try/catch instead of checking a flag it might forget. */
const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r?.ok) throw new Error(r?.error ?? 'the portal did not answer');
  return r.value;
};

contextBridge.exposeInMainWorld('portal', {
  getState:     ()               => call('portal:state'),
  addTopic:     (value)          => call('portal:addTopic', String(value ?? '')),
  removeTopic:  (key)            => call('portal:removeTopic', String(key ?? '')),
  sendFile:     ({ topicKey, name, mime, buffer }) =>
                                    call('portal:send', { topicKey, name, mime, buffer }),
  openFile:     (path)           => call('portal:open', String(path ?? '')),
  revealFile:   (path)           => call('portal:reveal', String(path ?? '')),
  revealFolder: ()               => call('portal:revealFolder'),

  /** Events pushed from main: state, status, log, file, progress.
   *  Returns an unsubscribe so a reload does not stack listeners. */
  onEvent(cb) {
    const listener = (_e, ev) => { try { cb(ev); } catch { /* a UI bug must not kill the channel */ } };
    ipcRenderer.on('portal:event', listener);
    return () => ipcRenderer.removeListener('portal:event', listener);
  },
});
