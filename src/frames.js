// Every piece of data in the pipeline is a Frame.
// Processors receive frames, do work, and emit new frames.

export class Frame {
  constructor() {
    this.timestamp = Date.now();
  }
}

// Raw audio bytes from mic or to speaker
export class AudioFrame extends Frame {
  constructor(audio) {
    super();
    this.audio = audio; // Buffer or Float32Array
  }
}

// Text from user (after STT) or going to TTS
export class TextFrame extends Frame {
  constructor(text) {
    super();
    this.text = text;
  }
}

// A chunk of LLM response (streaming token)
export class LLMResponseChunkFrame extends Frame {
  constructor(chunk) {
    super();
    this.chunk = chunk;
  }
}

// Signals that LLM is done streaming for this turn
export class LLMResponseEndFrame extends Frame {}

// Signals the user started speaking — used to trigger interruption
export class UserStartedSpeakingFrame extends Frame {}

// Signals the user stopped speaking
export class UserStoppedSpeakingFrame extends Frame {}

// Carries a complete transcription result
export class TranscriptionFrame extends Frame {
  constructor(text, isFinal = false) {
    super();
    this.text = text;
    this.isFinal = isFinal;
  }
}

// Poison pill — signals the pipeline to shut down cleanly
export class EndFrame extends Frame {}
