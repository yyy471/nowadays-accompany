"use strict";

// 用户读纸笺期间只续期。超时后回执作废，由原生对话独占本次决定。
function createWindowIntent({ send, reveal, fallback, commit, timeout = 4500 }) {
  let sequence = 0;
  let pending = null;
  let timer;
  function finish(request, accepted) {
    if (pending !== request) return;
    clearTimeout(timer);
    pending = null;
    if (accepted) commit(request.action);
  }
  function arm(request) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      request.native = true;
      send('cancel', request.id);
      reveal();
      let accepted = false;
      try { accepted = await fallback(request.action); }
      catch (error) { console.error('[DESK_NATIVE_CONFIRM_FAILED]', error); }
      finally { finish(request, accepted); }
    }, timeout);
  }
  return {
    get pending() { return pending !== null; },
    request(action) {
      if (pending) return;
      pending = { id: ++sequence, action, native: false, shown: false };
      arm(pending);
      send('request', { id: pending.id, action });
    },
    waiting(id) {
      if (!pending || pending.id !== id || pending.native) return;
      if (!pending.shown) reveal();
      pending.shown = true;
      arm(pending);
    },
    reply(id, accepted) {
      if (!pending || pending.id !== id || pending.native || typeof accepted !== 'boolean') return;
      finish(pending, accepted);
    }
  };
}
module.exports = { createWindowIntent };
