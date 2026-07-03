import { VaaniBot } from './bot.js';

if (!process.env.SARVAM_API_KEY || !process.env.GROQ_API_KEY) {
  console.error('Missing API keys. Ensure SARVAM_API_KEY and GROQ_API_KEY are set in .env');
  process.exit(1);
}

const bot = new VaaniBot();

process.on('SIGINT', () => {
  console.log('\n\nStopping...');
  bot.stop();
});

console.log('--- VaaniFlow Stage 6: Mic → STT → LLM → TTS ---');
console.log('Tip: run with DEBUG_STT=1 first session to verify VAD signal shapes.');
console.log('Speak into your mic. Ctrl+C to quit.\n');

await bot.start();

bot.history.print();
console.log('\n--- Session ended ---');
