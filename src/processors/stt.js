import { AudioFrame, TextFrame, TranscriptionFrame, UserStartedSpeakingFrame, UserStoppedSpeakingFrame, EndFrame } from '../frames.js';

export async function* sarvamSTT(frames) {
  for await (const frame of frames) {
    if (frame instanceof TextFrame) {
      yield new TranscriptionFrame(frame.text, true);
    } else {
      yield frame;
    }
  }
}

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

function normalizeTranscript(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function sttUrl() {
  const url = new URL('wss://api.sarvam.ai/speech-to-text/ws');
  url.searchParams.set('model', 'saaras:v3');
  url.searchParams.set('language-code', 'en-IN');
  url.searchParams.set('vad_signals', 'true');
  return url.toString();
}

export async function* sarvamSTTWebSocket(frames, ctx) {
  const pending = [];
  let wake = null;
  let ws = null;
  let sourceEnded = false;
  let reconnectTimer = null;
  let connecting = false;
  let connectionId = 0;
  let lastFinalTranscript = '';
  let lastFinalAt = 0;

  function nudge() {
    if (!wake) return;
    const resolve = wake;
    wake = null;
    resolve();
  }

  function enqueue(msg) {
    pending.push(msg);
    nudge();
  }

  function closeCurrentSocket() {
    if (!ws) return;
    try { ws.close(); } catch {}
    ws = null;
  }

  function scheduleReconnect(delayMs = 500) {
    if (sourceEnded || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectSocket();
    }, delayMs);
  }

  async function connectSocket() {
    if (sourceEnded || connecting) return;
    connecting = true;
    const id = ++connectionId;
    const socket = new WebSocket(
      sttUrl(),
      [`api-subscription-key.${process.env.SARVAM_API_KEY}`],
    );

    socket.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'events') {
          if (msg.data?.signal_type === 'START_SPEECH') {
            ctx.interrupt();
            console.log('\n[VAD] speech detected -> interrupted bot');
          } else if (msg.data?.signal_type === 'END_SPEECH') {
            console.log('[VAD] speech ended');
          }
        }
        enqueue(msg);
      } catch (err) {
        console.error('[STT] bad WS message:', err.message);
      }
    });

    socket.addEventListener('close', (event) => {
      if (ws === socket) ws = null;
      const reason = event.reason ? ` reason="${event.reason}"` : '';
      console.log(`[STT] WebSocket closed code=${event.code}${reason}`);
      if (!sourceEnded) scheduleReconnect();
    });

    socket.addEventListener('error', (event) => {
      console.error('[STT] WS error:', event.message ?? 'connection error');
    });

    try {
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
        socket.addEventListener('close', () => reject(new Error('socket closed before open')), { once: true });
      });

      if (sourceEnded || id !== connectionId) {
        try { socket.close(); } catch {}
        return;
      }

      ws = socket;
      console.log('[STT] WebSocket connected');
      nudge();
    } catch (err) {
      if (!sourceEnded) {
        console.error('[STT] connect failed:', err.message);
        scheduleReconnect(1000);
      }
    } finally {
      connecting = false;
    }
  }

  connectSocket();

  (async () => {
    for await (const frame of frames) {
      if (frame instanceof EndFrame) {
        sourceEnded = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        closeCurrentSocket();
        enqueue(frame);
        break;
      }

      if (frame instanceof AudioFrame && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          audio: {
            data: pcmToWav(frame.audio).toString('base64'),
            encoding: 'audio/wav',
            sample_rate: 16000,
          },
        }));
      }
    }
  })().catch(err => {
    sourceEnded = true;
    closeCurrentSocket();
    console.error('[STT] audio pump error:', err.message);
    enqueue(new EndFrame());
  });

  while (true) {
    if (pending.length === 0) await new Promise(resolve => { wake = resolve; });
    const msg = pending.shift();
    if (!msg) continue;

    if (msg instanceof EndFrame) {
      yield msg;
      return;
    }

    if (msg.type === 'events') {
      if (msg.data?.signal_type === 'START_SPEECH') yield new UserStartedSpeakingFrame();
      else if (msg.data?.signal_type === 'END_SPEECH') yield new UserStoppedSpeakingFrame();
    } else if (msg.type === 'data' && msg.data?.transcript) {
      const transcript = msg.data.transcript.trim();
      const normalized = normalizeTranscript(transcript);
      const now = Date.now();
      if (normalized && normalized === lastFinalTranscript && now - lastFinalAt < 4000) {
        console.log(`[STT] duplicate skipped: "${transcript}"`);
        continue;
      }
      lastFinalTranscript = normalized;
      lastFinalAt = now;
      console.log(`[STT] "${transcript}"`);
      yield new TranscriptionFrame(transcript, true);
    }
  }
}
