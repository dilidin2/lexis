/**
 * In-memory rolling buffer of recent raw chat messages.
 *
 * Short-term memory only stores (user message -> bot response) pairs, i.e.
 * messages the bot actually answered. Everything else — the bulk of the
 * chat — would be invisible to the autonomy check-in. This buffer keeps the
 * live conversation visible so the bot can react to what is being said
 * *right now* instead of recycling old topics.
 *
 * Deliberately not persisted: it only makes sense for the live moment.
 */
export interface ChatActivityEntry {
  username: string;
  message: string;
  ts: number;
}

export class ChatActivityBuffer {
  private entries: ChatActivityEntry[] = [];
  private maxEntries: number;
  private windowMs: number;

  constructor(maxEntries = 100, windowMs = 10 * 60 * 1000) {
    this.maxEntries = maxEntries;
    this.windowMs = windowMs;
  }

  add(username: string, message: string): void {
    this.entries.push({ username, message, ts: Date.now() });
    const cutoff = Date.now() - this.windowMs;
    while (this.entries.length > this.maxEntries || this.entries[0].ts < cutoff) {
      this.entries.shift();
    }
  }

  /** Messages from the last `windowMs`, oldest first. */
  recent(): ChatActivityEntry[] {
    return [...this.entries];
  }

  /** Human-readable block for LLM context. */
  formatRecent(): string {
    return this.entries.map((e) => `${e.username}: ${e.message}`).join('\n');
  }
}
