import { AudioFrame, TextFrame, TranscriptionFrame, UserStartedSpeakingFrame, UserStoppedSpeakingFrame, EndFrame } from '../frames.js';

// ─── Stage 4/5 passthrough ───────────────────────────────────────────────────
export async function* sarvamSTT(frames) {
  for await (const frame of frames) {
    if (frame instanceof TextFrame) {
      yield new TranscriptionFrame(frame.text, true);
    } else {
      yield frame;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pcmToWav(pcm, sampleRate = 16000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// ─── Stage 6: real Sarvam STT WebSocket ─────────────────────────────────────
//
// Protocol from the official Sarvam HTML example (sarvam-streaming-apis repo):
//   Auth  : WebSocket subprotocol `api-subscription-key.<key>` (not a header —
//           browsers cannot set custom WS headers, so Sarvam uses this field)
//   Send  : JSON { audio: { data: <base64 WAV>, encoding: "audio/wav", sample_rate: 16000 } }
//   Recv  : { type: "data", data: { transcript, request_id, metrics } }
//     + with vad_signals=true: { type: "speech_start" | "speech_end" } (shape unverified —
//       set DEBUG_STT=1 to log raw events and confirm before trusting barge-in)
//
// ctx.interrupt() is called from the WS message handler (side-channel), not from
// a pipeline processor. Same lesson as Stage 2 — interrupts must bypass the frame
// stream or they arrive too late while LLM/TTS is mid-generation.
//
export async function* sarvamSTTWebSocket(frames, ctx) {
  const pending = [];
  let wake = null;
  let socketClosed = false;

  function nudge() { if (wake) { const r = wake; wake = null; r(); } }

  const url = new URL('wss://api.sarvam.ai/speech-to-text/ws');
  url.searchParams.set('model', 'saaras:v3');
  url.searchParams.set('language-code', 'en-IN');
  url.searchParams.set('vad_signals', 'true');

  const ws = new WebSocket(
    url.toString(),
    [`api-subscription-key.${process.env.SARVAM_API_KEY}`],
  );

  let sentChunks = 0;

  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      // Confirmed shape: { type: "events", data: { signal_type: "START_SPEECH" | "END_SPEECH" } }
      if (msg.type === 'events') {
        if (msg.data?.signal_type === 'START_SPEECH') {
          ctx.interrupt();
          console.log('\n[VAD] speech detected → interrupted bot');
        } else if (msg.data?.signal_type === 'END_SPEECH') {
          console.log('[VAD] speech ended');
        }
      }
      pending.push(msg);
      nudge();
    } catch {}
  });

  ws.addEventListener('close', () => { socketClosed = true; nudge(); });
  ws.addEventListener('error', (e) => console.error('[STT] WS error:', e.message ?? e));

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  console.log('[STT] WebSocket connected');

  (async () => {
    for await (const frame of frames) {
      if (frame instanceof EndFrame) { ws.close(); break; }
      if (frame instanceof AudioFrame && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          audio: { data: pcmToWav(frame.audio).toString('base64'), encoding: 'audio/wav', sample_rate: 16000 },
        }));
        sentChunks++;
      }
    }
  })();

  while (!(socketClosed && pending.length === 0)) {
    if (pending.length === 0) await new Promise(r => { wake = r; });
    const msg = pending.shift();
    if (!msg) continue;

    if (msg.type === 'events') {
      if (msg.data?.signal_type === 'START_SPEECH') yield new UserStartedSpeakingFrame();
      else if (msg.data?.signal_type === 'END_SPEECH') yield new UserStoppedSpeakingFrame();
    } else if (msg.type === 'data' && msg.data?.transcript) {
      console.log(`[STT] "${msg.data.transcript}"`);
      yield new TranscriptionFrame(msg.data.transcript, true);
    }
  }

  yield new EndFrame();
}
