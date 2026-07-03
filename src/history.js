export class ConversationHistory {
  constructor() {
    this._messages = [];
    this._pendingUser = null;
    this._pendingAssistant = '';
  }

  startTurn(userText) {
    this._pendingUser = userText;
    this._pendingAssistant = '';
  }

  appendAssistantChunk(chunk) {
    this._pendingAssistant += chunk;
  }

  // Full turn completed — commit both sides.
  commitTurn() {
    if (this._pendingUser !== null) {
      this._messages.push({ role: 'user', content: this._pendingUser });
      this._messages.push({ role: 'assistant', content: this._pendingAssistant.trim() });
    }
    this._pendingUser = null;
    this._pendingAssistant = '';
  }

  // Turn was interrupted mid-response. Commit the user message plus whatever
  // the assistant managed to say (marked with '…') so the model retains context.
  // Without this, the model has no record the user asked anything — a follow-up
  // like "no, the second one" would be unresolvable.
  partialCommit() {
    if (this._pendingUser !== null) {
      this._messages.push({ role: 'user', content: this._pendingUser });
      const spoken = this._pendingAssistant.trim();
      if (spoken) {
        this._messages.push({ role: 'assistant', content: spoken + '…' });
      }
    }
    this._pendingUser = null;
    this._pendingAssistant = '';
  }

  get messages() {
    return this._messages;
  }

  print() {
    console.log('\n--- Conversation History ---');
    for (const msg of this._messages) {
      const label = msg.role === 'user' ? 'USER' : 'BOT ';
      console.log(`[${label}] ${msg.content}`);
    }
    console.log('----------------------------');
  }
}
