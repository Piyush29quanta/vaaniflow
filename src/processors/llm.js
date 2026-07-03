import { TranscriptionFrame, LLMResponseChunkFrame, LLMResponseEndFrame } from '../frames.js';

const BASE_URL = 'https://api.groq.com/openai/v1';
const MODEL = 'llama-3.3-70b-versatile'; // swap to 'llama-3.1-8b-instant' for lower latency
const SYSTEM_PROMPT = `You are a helpful voice assistant. You are speaking out loud, not writing text.

Rules you must follow:
- Keep every reply under 3 sentences. Shorter is better.
- Use natural spoken language. Contractions are fine.
- Never use markdown: no bullet points, no bold, no headers, no lists.
- Never start with filler like "Sure!", "Certainly!", "Great question!", or "Of course!".
- If you don't know something, say so briefly and move on.
- If a question needs a list, say it as a sentence: "The main ones are X, Y, and Z."
- Spell out numbers as words when they appear mid-sentence.
- If the conversation history shows a truncated response (ending in …), the user interrupted you — don't repeat what was already said.`;
const decoder = new TextDecoder();

export async function* sarvamLLM(frames, ctx, history) {
  for await (const frame of frames) {
    if (!(frame instanceof TranscriptionFrame && frame.isFinal)) {
      yield frame;
      continue;
    }

    ctx.reset();
    history.startTurn(frame.text);
    console.log(`\n[LLM] user: "${frame.text}"`);

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.messages,
      { role: 'user', content: frame.text },
    ];

    let response;
    try {
      response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: MODEL, messages, stream: true, max_tokens: 120 }),
      });
    } catch (err) {
      console.error('[LLM] network error:', err.message);
      history.partialCommit();
      continue;
    }

    if (!response.ok) {
      console.error(`[LLM] API error ${response.status}:`, await response.text());
      history.partialCommit();
      continue;
    }

    process.stdout.write('[LLM→TTS] ');
    let remainder = '';

    for await (const raw of response.body) {
      if (ctx.interrupted) {
        history.partialCommit();
        console.log('\n[LLM] interrupted');
        break;
      }

      remainder += decoder.decode(raw, { stream: true });
      const lines = remainder.split('\n');
      remainder = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        try {
          const token = JSON.parse(payload).choices?.[0]?.delta?.content;
          if (token) {
            history.appendAssistantChunk(token);
            yield new LLMResponseChunkFrame(token);
          }
        } catch { /* malformed SSE line */ }
      }
    }

    if (!ctx.interrupted) {
      history.commitTurn();
      yield new LLMResponseEndFrame();
    }
  }
}
