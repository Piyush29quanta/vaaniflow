import { spawn } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { LLMResponseChunkFrame, LLMResponseEndFrame } from '../frames.js';

const BASE_URL = 'https://api.sarvam.ai';

function sentenceEnd(text) {
  const match = text.match(/[.!?](\s+|$)/);
  if (!match) return -1;
  return match.index + match[0].length;
}

async function callTTS(text, signal) {
  const response = await fetch(`${BASE_URL}/text-to-speech`, {
    method: 'POST',
    headers: {
      'api-subscription-key': process.env.SARVAM_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      target_language_code: 'en-IN',
      model: 'bulbul:v3',
      speaker: 'priya',
      speech_sample_rate: 16000,
    }),
    signal,
  });
  if (!response.ok) throw new Error(`TTS ${response.status}: ${await response.text()}`);
  const json = await response.json();
  return json.audios?.[0];
}

function playSox(filename, signal) {
  const sox = process.env.SOX_PATH ?? 'sox';
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => { if (!settled) { settled = true; resolve(); } };

    const proc = spawn(sox, ['-q', filename, '-d'], { stdio: 'ignore' });
    signal.addEventListener('abort', () => { try { proc.kill(); } catch {} settle(); }, { once: true });
    proc.on('close', settle);
    proc.on('error', settle);
  });
}

async function speakSentence(text, ctx) {
  const controller = new AbortController();
  ctx._onInterrupt = () => controller.abort();

  try {
    process.stdout.write(`\n[TTS▶] "${text.trim()}"`);
    const b64 = await callTTS(text.trim(), controller.signal);
    if (!b64 || controller.signal.aborted) return;

    const filename = `tts_${Date.now()}.wav`;
    await writeFile(filename, Buffer.from(b64, 'base64'));
    try {
      await playSox(filename, controller.signal);
    } finally {
      await unlink(filename).catch(() => {});
    }
  } catch (err) {
    if (err.name !== 'AbortError') console.error(`\n[TTS] error: ${err.message}`);
  } finally {
    ctx._onInterrupt = null;
  }
}

export async function* sarvamTTS(frames, ctx, onTurnEnd) {
  const buf = { pending: '' };

  // Fires at speech_start, before ctx.reset() runs — clears the unspoken tail
  // immediately so turn N+1's chunks can't weld onto stale text.
  // A plain `let pending` can't be reached by this closure after reassignment;
  // the object wrapper keeps the reference live.
  ctx._onTTSInterrupt = () => { buf.pending = ''; };

  for await (const frame of frames) {
    if (frame instanceof LLMResponseChunkFrame) {
      if (ctx.interrupted) continue;
      buf.pending += frame.chunk;

      let end;
      while (!ctx.interrupted && (end = sentenceEnd(buf.pending)) !== -1) {
        const sentence = buf.pending.slice(0, end).trim();
        buf.pending = buf.pending.slice(end);
        if (sentence) await speakSentence(sentence, ctx);
      }
    } else if (frame instanceof LLMResponseEndFrame) {
      if (buf.pending.trim() && !ctx.interrupted) {
        await speakSentence(buf.pending.trim(), ctx);
      }
      buf.pending = '';
      console.log('\n[TTS] turn complete');
      onTurnEnd();
    } else {
      yield frame;
    }
  }
}
