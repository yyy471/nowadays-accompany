(function (root) {
  'use strict';
  const D = typeof module === 'object' && module.exports ? require('./engine.js') : root.DialogueDemo3;

  class Performance {
    constructor({ scenario, empty, onChange, clock = globalThis }) {
      this.scenario = scenario;
      this.onChange = onChange;
      this.clock = clock;
      this.messages = [];
      this.scenes = new Map();
      this.timers = new Set();
      this.turn = 0;
      this.serial = 0;
      this.active = null;
      this.current = null;
      this.error = '';
      this.autoScene = false;
      if (empty) return;
      for (const message of D.seedMessages(Date.now(), scenario === 'long')) {
        const messageId = `history-${message.id}`;
        let ordinal = 0;
        if (message.action) this.addRow(messageId, { action: message.action, ordinal: ordinal++ }, message.createdAt);
        const paragraphs = message.role === 'assistant' ? message.text.split(/\n\s*\n/u) : [message.text];
        for (const text of paragraphs) this.addRow(messageId, { text, ordinal: ordinal++ }, message.createdAt, message.role);
      }
    }

    addRow(messageId, content, createdAt, role = 'assistant') {
      const ordinal = content.ordinal ?? 0;
      const row = {
        id: ++this.serial, messageId, segmentId: `${messageId}-${ordinal}`, ordinal,
        role, text: content.text ?? '', action: content.action ?? '', actionVisible: Boolean(content.action),
        sprite: content.sprite ?? null, status: 'completed', createdAt,
      };
      this.messages.push(row);
      return row;
    }

    snapshot() {
      return {
        messages: this.messages.map(row => ({ ...row })),
        activeId: this.active?.id ?? null,
        canAdvance: this.active ? this.active.shown < this.active.ready : false,
        current: this.current, error: this.error, scenes: Array.from(this.scenes.values()),
        availableRounds: new Set(this.messages.filter(row => row.role === 'assistant' &&
          (row.messageId !== this.active?.id || this.active.finished)).map(row => row.messageId)),
      };
    }

    emit(reason, row) {
      this.onChange(this.snapshot(), { reason, id: row?.id, row });
    }

    later(delay, callback) {
      const id = this.clock.setTimeout(() => {
        this.timers.delete(id);
        callback();
      }, delay);
      this.timers.add(id);
    }

    send(value) {
      const text = value.trim();
      if (!text || this.active) return false;
      const id = `turn-${++this.turn}`;
      const createdAt = Date.now();
      this.error = '';
      this.current = null;
      this.addRow(`user-${this.turn}`, { text }, createdAt, 'user');
      const reply = D.replyFor(text, this.turn);
      const [first, ...rest] = reply.text.split(/\n\s*\n/u);
      const lines = [{ text: first, sprite: 'standing' }];
      if (this.scenario !== 'single') {
        if (reply.action) lines.push({ action: D.cleanAction(reply.action), sprite: 'sitting' });
        for (const next of rest) lines.push({ text: next });
      }
      const run = { id, lines, createdAt, ready: 0, shown: 0, finished: false };
      this.active = run;
      this.emit('send');
      if (this.scenario === 'failure') {
        this.later(480, () => {
          if (this.active !== run) return;
          this.active = null;
          this.error = '这轮回复暂时没有送达，可以再发一条。';
          this.emit('failed');
        });
        return true;
      }
      this.later(440, () => this.receive(run));
      return true;
    }

    receive(run) {
      if (this.active !== run) return;
      run.ready += 1;
      if (this.scenario === 'interrupted' && run.ready === 2) {
        run.lines.length = 2;
        run.interrupted = true;
      }
      run.finished = run.ready === run.lines.length;
      if (run.shown === 0) this.advance();
      else this.emit('ready');
      if (run.finished && this.autoScene && !run.interrupted) {
        this.requestScene(run.id, this.turn % 2 ? 'background' : 'full_scene', 'auto');
      }
      if (!run.finished) this.later(this.scenario === 'slow' ? 1550 : 700, () => this.receive(run));
    }

    advance() {
      const run = this.active;
      if (!run || run.shown >= run.ready) return false;
      const ordinal = run.shown++;
      const row = this.addRow(run.id, { ...run.lines[ordinal], ordinal }, run.createdAt);
      this.current = row;
      if (run.finished && run.shown === run.lines.length) {
        if (run.interrupted) row.status = 'interrupted';
        this.active = null;
      }
      this.emit('segment', row);
      return true;
    }

    requestScene(messageId, mode, source = 'manual') {
      const rows = this.messages.filter(row => row.messageId === messageId && row.role === 'assistant');
      const run = this.active?.id === messageId ? this.active : null;
      if (rows.length === 0 || (run && !run.finished) || !['background', 'full_scene'].includes(mode)) return;
      const id = `${messageId}:${mode}`;
      if (this.scenes.has(id) && this.scenes.get(id).status !== 'failed') return;
      const count = run?.lines.length ?? rows.length;
      const start = rows[0].ordinal;
      const end = count > 1 ? Math.max(start, count - 2) : start;
      const scene = {
        id, messageId, mode, start, end, status: 'generating', source,
        startSegmentId: `${messageId}-${start}`, endSegmentId: `${messageId}-${end}`,
      };
      this.scenes.set(id, scene);
      this.emit('scene');
      this.later(this.scenario === 'slow' ? 3200 : 1400, () => {
        this.scenes.set(id, { ...scene, status: this.scenario === 'scene-failure' ? 'failed' : 'succeeded' });
        this.emit('scene');
      });
    }

    dispose() {
      for (const id of this.timers) this.clock.clearTimeout(id);
      this.timers.clear();
    }
  }

  if (typeof module === 'object' && module.exports) module.exports = { Performance };
  else root.DialoguePerformance = Performance;
})(globalThis);
