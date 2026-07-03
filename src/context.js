export class PipelineContext {
  constructor() {
    this.interrupted = false;
    this._onInterrupt = null;    // kills in-flight fetch + sox player (per-sentence)
    this._onTTSInterrupt = null; // clears unspoken buffer (per-turn)
    this._initSignal();
  }

  _initSignal() {
    this.interruptSignal = new Promise(r => this._resolve = r);
  }

  interrupt() {
    this.interrupted = true;
    this._resolve();
    this._onInterrupt?.();    // kills in-flight fetch + sox
    this._onTTSInterrupt?.(); // clears unspoken buffer before reset() flips interrupted
  }

  reset() {
    this.interrupted = false;
    this._onInterrupt = null;
   // this._onTTSInterrupt = null;
    this._initSignal();
  }
}
