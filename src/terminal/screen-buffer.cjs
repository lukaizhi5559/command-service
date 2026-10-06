'use strict';

/**
 * terminal/screen-buffer.cjs
 *
 * Two views over a PTY's output stream:
 *
 *  1. @xterm/headless Terminal — an accurate screen model (cursor, scroll
 *     regions, curses-style repaints). `screen()` answers "what does the
 *     display look like right now" for interactive menus.
 *
 *  2. Raw ring buffer — every byte received, capped. Powers regex `wait`
 *     matching and transcript writing; survives scroll-region redraws that
 *     would erase lines from the screen view.
 *
 * Plus an ANSI-stripped text view for transcripts/LLM context.
 */

const { Terminal } = require('@xterm/headless');

const RAW_CAP = 512 * 1024;        // 512KB ring
const STRIP_CAP = 256 * 1024;      // stripped transcript tail cap

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|\([A-Z]|\)[A-Z0-9]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g;

function stripAnsi(s) {
  return String(s || '').replace(ANSI_RE, '').replace(/\r(?!\n)/g, '\n');
}

class ScreenBuffer {
  constructor(cols = 120, rows = 30) {
    this.term = new Terminal({
      cols, rows,
      scrollback: 1000,
      allowProposedApi: true,
    });
    this.rawBuf = '';
    this.rawOffset = 0;        // absolute byte position of rawBuf start
    this.strippedTail = '';    // ANSI-stripped tail for transcripts/LLM
    this._writeQueue = Promise.resolve(); // xterm write is async — serialize
  }

  write(data) {
    if (!data) return;
    this.rawBuf += data;
    if (this.rawBuf.length > RAW_CAP) {
      const drop = this.rawBuf.length - RAW_CAP;
      this.rawBuf = this.rawBuf.slice(drop);
      this.rawOffset += drop;
    }
    const stripped = stripAnsi(data);
    this.strippedTail += stripped;
    if (this.strippedTail.length > STRIP_CAP) {
      this.strippedTail = this.strippedTail.slice(this.strippedTail.length - STRIP_CAP);
    }
    // xterm write is callback-based; queue so callers can flush before screen reads
    this._writeQueue = this._writeQueue.then(() => new Promise((res) => {
      try { this.term.write(data, res); } catch (_) { res(); }
    }));
  }

  /** Wait until all queued writes have been parsed into the screen model. */
  async flush() { await this._writeQueue; }

  /** Current screen contents (viewport only), trimmed of trailing blank lines. */
  screen() {
    const buf = this.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    }
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return lines.join('\n');
  }

  /** Last n lines including scrollback tail. */
  tailLines(n = 40) {
    const buf = this.term.buffer.active;
    const start = Math.max(0, buf.length - Math.max(buf.viewportY, 0) - 1 - n);
    const lines = [];
    for (let i = start; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    }
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return lines.slice(-n).join('\n');
  }

  /**
   * Raw output received since an absolute offset. Pass the offset returned
   * in the previous call's `offset` to page through; pass null/0 for all
   * buffered output.
   */
  rawSince(offset) {
    const abs = typeof offset === 'number' ? offset : 0;
    const idx = Math.max(0, abs - this.rawOffset);
    return {
      data: this.rawBuf.slice(idx),
      offset: this.rawOffset + this.rawBuf.length,
    };
  }

  /** ANSI-stripped tail of everything received (bounded), for transcripts. */
  strippedText() { return this.strippedTail; }
}

module.exports = { ScreenBuffer, stripAnsi };
