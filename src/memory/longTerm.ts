import * as fs from 'fs';
import * as path from 'path';
import { LLMClient, ChatMessage } from '../llm/client';
import { ShortTermMemory, ShortTermMemoryEntry } from './shortTerm';

const MEMORY_FILE = path.join(__dirname, '..', '..', 'MEMORY.md');

export class LongTermMemory {
  private llm: LLMClient;

  constructor(llm: LLMClient) {
    this.llm = llm;
    this.ensureFileExists();
  }

  private ensureFileExists(): void {
    if (!fs.existsSync(MEMORY_FILE)) {
      fs.writeFileSync(MEMORY_FILE, '# Lexis Long-Term Memory\n\nThis file stores important facts, preferences, and recurring themes learned from chat interactions.\n', 'utf-8');
    }
  }

  load(): string {
    try {
      return fs.readFileSync(MEMORY_FILE, 'utf-8');
    } catch (error) {
      console.error(`[ERROR] Failed to read MEMORY.md: ${error}`);
      return '';
    }
  }

  private append(content: string): void {
    try {
      const current = this.load();
      const separator = current.trim().endsWith('---') ? '\n' : '\n---\n';
      fs.writeFileSync(MEMORY_FILE, current + separator + content + '\n', 'utf-8');
      console.log('[INFO] Long-term memory updated');
    } catch (error) {
      console.error(`[ERROR] Failed to write MEMORY.md: ${error}`);
    }
  }

  async consolidate(shortTermMemory: ShortTermMemory): Promise<void> {
    const timeout = setTimeout(() => {
      console.error('[ERROR] Memory consolidation timed out, aborting');
    }, 60000);

    try {
      console.log('[INFO] Memory consolidation started');

      const recentEntries = shortTermMemory.getRecentEntries(50);
      const currentMemory = this.load();

      const conversationsText = recentEntries
        .map(entry => `${entry.username}: ${entry.userMessage}\nLexis: ${entry.botResponse}`)
        .join('\n\n');

      const systemPrompt = `You are Lexis, an AI chat bot on Twitch. You are reviewing recent conversations
to decide if anything important should be saved to your long-term memory.

Below is your current long-term memory file (MEMORY.md):

=== CURRENT MEMORY ===
${currentMemory}
=== END CURRENT MEMORY ===

Below are recent conversations from the chat. Each line shows:
- Username: the person who messaged
- Their message to you
- Your response

=== RECENT CONVERSATIONS ===
${conversationsText}
=== END RECENT CONVERSATIONS ===

YOUR TASK:
Decide if any information from these conversations should be added to your
long-term memory. Be VERY selective.

ACCEPT into memory ONLY if:
- A user shares something personal about themselves (name, interests, hobbies,
  profession, location, preferences) that seems meaningful and recurring
- A user explicitly asks you to remember something specific about them
- You notice a recurring theme, inside joke, or running conversation topic
  that appears multiple times across different interactions
- A user corrects you about something and you should remember the correction
- A user shares a significant life event (birthday, achievement, milestone)
- You learn something about the streamer or the channel culture that helps
  you understand the community better

REJECT from memory (do NOT save) if:
- It's a one-off comment or throwaway remark with no lasting relevance
- It's general chat banter, greetings, or common questions
- It's something that would be obvious from context of future conversations
- It's repetitive information already in your current memory
- It's sensitive/private information that a user might not want permanently stored
- It's a joke, meme reference, or trend that will be outdated soon
- It's just a normal question and answer with no special significance
- The information is too vague or unclear to be useful later

OUTPUT FORMAT:
- If nothing should be saved, respond with exactly: NO
- If something should be saved, respond with the new memory entries in markdown
  format. Each entry should be concise (1-2 lines). Use bullet points or numbered
  lists. Group related items together under headings if appropriate.`;

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
      ];

      const result = await this.llm.consolidationCompletion(messages);

      if (!result) {
        console.warn('[WARN] Consolidation returned no result, skipping');
        return;
      }

      if (result.trim().toUpperCase() === 'NO') {
        console.log('[INFO] Nothing to save in memory consolidation');
        return;
      }

      this.append(result.trim());
      shortTermMemory.resetCounter();
      console.log('[INFO] Memory consolidation complete');
    } finally {
      clearTimeout(timeout);
    }
  }
}
