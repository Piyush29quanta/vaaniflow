import { EndFrame } from './frames.js';

export class Pipeline {
  constructor(processors) {
    this.processors = processors;
  }

  async run(source) {
    let stream = source;
    for (const processor of this.processors) {
      stream = processor(stream);
    }
    for await (const frame of stream) {
      if (frame instanceof EndFrame) break;
    }
  }
}

// A queue that decouples a push-based source from the pull-based pipeline.
// The source pushes frames independently; the pipeline pulls when ready.
export class FrameQueue {
  constructor() {
    this._queue = [];
    this._waiters = [];
  }

  push(frame) {
    if (this._waiters.length > 0) {
      this._waiters.shift()(frame);
    } else {
      this._queue.push(frame);
    }
  }

  async _pull() {
    if (this._queue.length > 0) return this._queue.shift();
    return new Promise(resolve => this._waiters.push(resolve));
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const frame = await this._pull();
      yield frame;
      if (frame instanceof EndFrame) return;
    }
  }
}

export async function* fromFrames(frames) {
  for (const frame of frames) {
    yield frame;
  }
}

export async function* logger(frames, label = 'pipeline') {
  for await (const frame of frames) {
    console.log(`[${label}] ${frame.constructor.name}`,
      'text' in frame ? `"${frame.text}"` :
      'chunk' in frame ? `"${frame.chunk}"` : ''
    );
    yield frame;
  }
}
