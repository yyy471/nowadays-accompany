/** 按顺序同步一个客户端的输入状态，窗口关闭时在最后一次请求后清理。 */
export function createTypingState({ update, clear, delay = 1000, setTimer = setTimeout, cancelTimer = clearTimeout }) {
  let timer;
  let revision = 0;
  let sentRevision = 0;
  let typing = false;
  let closed = false;
  let running = false;
  let done = Promise.resolve();

  function pump() {
    if (running || closed || revision === sentRevision) return;
    running = true;
    const current = revision;
    const value = typing;
    done = Promise.resolve().then(() => update(value)).catch(() => {}).then(() => {
      sentRevision = current;
      running = false;
      pump();
    });
  }

  function set(value) {
    if (closed) return;
    typing = value;
    revision += 1;
    pump();
  }

  return {
    input() {
      if (closed) return;
      if (timer !== undefined) cancelTimer(timer);
      set(true);
      timer = setTimer(() => { timer = undefined; set(false); }, delay);
    },
    stop() {
      if (timer !== undefined) cancelTimer(timer);
      timer = undefined;
      set(false);
    },
    close() {
      if (closed) return done;
      closed = true;
      if (timer !== undefined) cancelTimer(timer);
      timer = undefined;
      done = done.then(() => clear()).catch(() => {});
      return done;
    }
  };
}
