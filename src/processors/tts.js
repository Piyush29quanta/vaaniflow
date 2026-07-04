import { spawn } from 'child_process';
import { once } from 'events';
import { writeFile, unlink } from 'fs/promises';
import { createInterface } from 'readline';
import { LLMResponseChunkFrame, LLMResponseEndFrame, EndFrame } from '../frames.js';

const BASE_URL = 'https://api.sarvam.ai';
const TTS_MODE = process.env.TTS_MODE ?? (process.platform === 'win32' ? 'local' : 'rest');

let windowsTTSWorker = null;

function sentenceEnd(text) {
  const match = text.match(/[.!?](\s+|$)/);
  if (!match) return -1;
  return match.index + match[0].length;
}

function ttsBody(text) {
  return {
    text,
    target_language_code: 'en-IN',
    model: 'bulbul:v3',
    speaker: 'priya',
    speech_sample_rate: 16000,
    output_audio_codec: 'wav',
  };
}

function describeError(err) {
  const parts = [err?.message ?? String(err)];
  if (err?.cause?.code) parts.push(err.cause.code);
  if (err?.cause?.message) parts.push(err.cause.message);
  return parts.filter(Boolean).join(' / ');
}

function createWindowsTTSWorker() {
  const script = `
Add-Type -AssemblyName System.Speech
$speaker = [System.Speech.Synthesis.SpeechSynthesizer]::new()
$speaker.SetOutputToDefaultAudioDevice()
$speaker.Rate = 1
[Console]::Out.WriteLine('__READY__')
[Console]::Out.Flush()
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ($line -eq '__EXIT__') { break }
  try {
    $bytes = [Convert]::FromBase64String($line)
    $text = [Text.Encoding]::UTF8.GetString($bytes)
    $speaker.Speak($text)
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
  }
  [Console]::Out.WriteLine('__DONE__')
  [Console]::Out.Flush()
}
$speaker.Dispose()
`;

  const proc = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: proc.stdout });
  let readyResolve;
  let readyReject;
  let speakResolve = null;
  let alive = true;

  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  lines.on('line', (line) => {
    if (line === '__READY__') readyResolve();
    else if (line === '__DONE__' && speakResolve) {
      const resolve = speakResolve;
      speakResolve = null;
      resolve(true);
    }
  });

  proc.stderr.on('data', chunk => {
    const message = Buffer.from(chunk).toString().trim();
    if (message) console.error(`\n[TTS] local worker: ${message}`);
  });

  proc.on('close', () => {
    alive = false;
    readyReject(new Error('local TTS worker exited'));
    if (speakResolve) {
      const resolve = speakResolve;
      speakResolve = null;
      resolve(false);
    }
  });

  return {
    async speak(text, signal) {
      if (!alive) return false;
      await ready;
      if (signal.aborted || !alive) return true;

      return await new Promise((resolve) => {
        speakResolve = resolve;
        const abort = () => {
          try { proc.kill(); } catch {}
          windowsTTSWorker = null;
          resolve(true);
        };
        signal.addEventListener('abort', abort, { once: true });
        proc.stdin.write(`${Buffer.from(text, 'utf8').toString('base64')}\n`, (err) => {
          if (err) {
            signal.removeEventListener('abort', abort);
            speakResolve = null;
            resolve(false);
          }
        });
      });
    },
    stop() {
      try { proc.stdin.write('__EXIT__\n'); } catch {}
      try { proc.kill(); } catch {}
    },
  };
}

function getWindowsTTSWorker() {
  if (!windowsTTSWorker) {
    console.log('[TTS] warming up local Windows voice');
    windowsTTSWorker = createWindowsTTSWorker();
  }
  return windowsTTSWorker;
}

if (TTS_MODE === 'local' && process.platform === 'win32') {
  getWindowsTTSWorker();
}

async function playWindowsTTS(text, signal) {
  if (process.platform !== 'win32') return false;
  try {
    return await getWindowsTTSWorker().speak(text, signal);
  } catch (err) {
    console.error(`\n[TTS] local playback failed: ${describeError(err)}`);
    windowsTTSWorker = null;
    return false;
  }
}

async function openTTSStream(text, signal) {
  let response;
  try {
    response = await fetch(`${BASE_URL}/text-to-speech/stream`, {
      method: 'POST',
      headers: {
        'api-subscription-key': process.env.SARVAM_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(ttsBody(text)),
      signal,
    });
  } catch (err) {
    throw new Error(`stream fetch failed: ${describeError(err)}`);
  }

  if (!response.ok) throw new Error(`stream TTS ${response.status}: ${await response.text()}`);
  if (!response.body) throw new Error('stream TTS response had no body');
  return response.body;
}

async function callTTSRest(text, signal) {
  let response;
  try {
    response = await fetch(`${BASE_URL}/text-to-speech`, {
      method: 'POST',
      headers: {
        'api-subscription-key': process.env.SARVAM_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(ttsBody(text)),
      signal,
    });
  } catch (err) {
    throw new Error(`REST fetch failed: ${describeError(err)}`);
  }

  if (!response.ok) throw new Error(`REST TTS ${response.status}: ${await response.text()}`);
  const json = await response.json();
  const b64 = json.audios?.[0];
  if (!b64) throw new Error('REST TTS response had no audio');
  return Buffer.from(b64, 'base64');
}

function spawnSox(args, signal) {
  const sox = process.env.SOX_PATH ?? 'sox';
  const proc = spawn(sox, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  const stderr = [];
  const done = once(proc, 'close').catch(() => [1]);

  proc.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
  signal.addEventListener('abort', () => {
    try { proc.stdin.destroy(); } catch {}
    try { proc.kill(); } catch {}
  }, { once: true });

  return { proc, stderr, done };
}

async function waitForSox(done, stderr, signal) {
  const [code] = await done;
  if (signal.aborted) return true;
  if (code === 0) return true;

  const message = Buffer.concat(stderr).toString().trim();
  if (message) console.error(`\n[TTS] SoX playback failed: ${message}`);
  else console.error(`\n[TTS] SoX playback failed with exit code ${code}`);
  return false;
}

async function playSoxFile(audio, signal) {
  const filename = `tts_${Date.now()}.wav`;
  await writeFile(filename, audio);

  try {
    const { proc, stderr, done } = spawnSox(['-q', filename, '-d'], signal);
    proc.stdin.end();
    return await waitForSox(done, stderr, signal);
  } finally {
    await unlink(filename).catch(() => {});
  }
}

async function playSoxStream(audioStream, signal) {
  const chunks = [];
  const { proc, stderr, done } = spawnSox(['-q', '-t', 'wav', '-', '-d'], signal);
  let procClosed = false;

  proc.on('close', () => { procClosed = true; });
  proc.stdin.on('error', () => { procClosed = true; });

  try {
    for await (const chunk of audioStream) {
      const audioChunk = Buffer.from(chunk);
      chunks.push(audioChunk);

      if (signal.aborted || procClosed) continue;
      if (!proc.stdin.write(audioChunk)) {
        await Promise.race([
          once(proc.stdin, 'drain').catch(() => {}),
          once(proc, 'close').catch(() => {}),
        ]);
      }
    }
  } catch (err) {
    if (!signal.aborted) console.error(`\n[TTS] stream read error: ${describeError(err)}`);
  } finally {
    try { proc.stdin.end(); } catch {}
  }

  const played = await waitForSox(done, stderr, signal);
  if (played || signal.aborted) return true;

  const audio = Buffer.concat(chunks);
  if (audio.length === 0) return false;
  console.log('\n[TTS] Retrying playback from temporary WAV file');
  return await playSoxFile(audio, signal);
}

async function speakSentence(text, ctx) {
  const controller = new AbortController();
  ctx._onInterrupt = () => controller.abort();
  const cleanText = text.trim();

  try {
    process.stdout.write(`\n[TTS:${TTS_MODE}] "${cleanText}"`);

    if (TTS_MODE === 'local') {
      const played = await playWindowsTTS(cleanText, controller.signal);
      if (played || controller.signal.aborted) return;
      console.error('\n[TTS] local playback failed; falling back to REST');
    }

    if (TTS_MODE === 'stream') {
      try {
        const audioStream = await openTTSStream(cleanText, controller.signal);
        if (controller.signal.aborted) return;
        const played = await playSoxStream(audioStream, controller.signal);
        if (played || controller.signal.aborted) return;
        console.error('\n[TTS] streaming playback failed; falling back to REST');
      } catch (err) {
        if (err.name === 'AbortError' || controller.signal.aborted) return;
        console.error(`\n[TTS] streaming failed; falling back to REST: ${describeError(err)}`);
      }
    }

    const audio = await callTTSRest(cleanText, controller.signal);
    if (controller.signal.aborted) return;
    await playSoxFile(audio, controller.signal);
  } catch (err) {
    if (err.name !== 'AbortError') console.error(`\n[TTS] error: ${describeError(err)}`);
  } finally {
    ctx._onInterrupt = null;
  }
}

export async function* sarvamTTS(frames, ctx, onTurnEnd) {
  const buf = { pending: '' };

  // Fires at speech_start, before ctx.reset() runs. Clears the unspoken tail
  // immediately so turn N+1's chunks can't weld onto stale text.
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
    } else if (frame instanceof EndFrame) {
      if (windowsTTSWorker) {
        windowsTTSWorker.stop();
        windowsTTSWorker = null;
      }
      yield frame;
    } else {
      yield frame;
    }
  }
}
