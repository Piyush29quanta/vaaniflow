import { fileURLToPath } from 'url';
import path from 'path';
import recorder from 'node-record-lpcm16';
import { Pipeline, FrameQueue } from './pipeline.js';
import { PipelineContext } from './context.js';
import { ConversationHistory } from './history.js';
import { sarvamSTTWebSocket } from './processors/stt.js';
import { sarvamLLM } from './processors/llm.js';
import { sarvamTTS } from './processors/tts.js';
import { AudioFrame, EndFrame } from './frames.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.join(__dirname, '..', 'bin');

// 250ms of 16kHz 16-bit mono PCM. Smaller chunks reach streaming STT sooner.
const CHUNK_BYTES = 16000 * 2 * 0.25;

export class VaaniBot {
  constructor() {
    this.ctx = new PipelineContext();
    this.history = new ConversationHistory();
    this.queue = new FrameQueue();
    this._rec = null;
    this._audioBuffer = Buffer.alloc(0);

    this.pipeline = new Pipeline([
      (s) => sarvamSTTWebSocket(s, this.ctx),
      (s) => sarvamLLM(s, this.ctx, this.history),
      (s) => sarvamTTS(s, this.ctx, () => {}),
    ]);
  }

  start() {
    // node-record-lpcm16 hardcodes 'sox' as the command name;
    // prepend bin/ to PATH so it resolves to our local binary.
    process.env.PATH = `${BIN_DIR}${path.delimiter}${process.env.PATH}`;
    process.env.SOX_PATH = path.join(BIN_DIR, 'sox.exe'); // used by sarvamTTS

    this._rec = recorder.record({
      sampleRate: 16000,
      channels: 1,
      audioType: 'raw',
      recorder: 'sox',
      verbose: false,
    });

    this._rec.stream()
      .on('data', (chunk) => this._onAudio(chunk))
      .on('error', (err) => {
        const msg = err?.message ?? String(err);
        if (!msg.includes('SIGTERM')) console.error('[Mic]', msg);
      });

    return this.pipeline.run(this.queue);  // returns a Promise that resolves when done
  }

  stop() {
    if (!this._rec) return;
    this._rec.stop();
    if (this._audioBuffer.length > 0) {
      this.queue.push(new AudioFrame(this._audioBuffer));
      this._audioBuffer = Buffer.alloc(0);
    }
    setTimeout(() => this.queue.push(new EndFrame()), 300);
  }

  _onAudio(chunk) {
    this._audioBuffer = Buffer.concat([this._audioBuffer, chunk]);
    while (this._audioBuffer.length >= CHUNK_BYTES) {
      this.queue.push(new AudioFrame(this._audioBuffer.subarray(0, CHUNK_BYTES)));
      this._audioBuffer = this._audioBuffer.subarray(CHUNK_BYTES);
    }
  }
}
