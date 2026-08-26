import * as fs from 'fs';
import * as path from 'path';
import { LLMClient, ChatMessage, ToolDefinition, ToolCall } from '../llm/client';
import { ShortTermMemory } from './shortTerm';
import { logger, MemoryFileStats } from '../logger';

const MEMORY_FILE = path.join(__dirname, '..', '..', 'MEMORY.md');
const MAX_TOOL_ITERATIONS = 8;

const MEMORY_EDIT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'edit_memory',
      description:
        'Replace an exact, unique piece of text in MEMORY.md with new text. old_text must match ' +
        'the current file content exactly, including whitespace, and must appear exactly once. ' +
        'Use this to correct, update, or remove existing entries (pass an empty new_text to delete ' +
        'old_text). Do not use this to add brand-new content that has no existing match — use ' +
        'append_memory for that instead.',
      parameters: {
        type: 'object',
        properties: {
          old_text: {
            type: 'string',
            description: 'Exact text currently in MEMORY.md to replace. Must match exactly and be unique in the file.',
          },
          new_text: {
            type: 'string',
            description: 'Text to replace old_text with. Use an empty string to delete old_text entirely.',
          },
        },
        required: ['old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_memory',
      description: 'Append a new markdown bullet point to MEMORY.md. It is inserted under the "## Uncategorized" section. Use this to add entries that do not already exist in the file.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Markdown content to append, e.g. a new bullet point or a new section with a heading.',
          },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description:
        'Call this when you are finished editing MEMORY.md, even if you made no edits at all. ' +
        'This ends the memory consolidation session and returns control to the chat bot.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'One short sentence summarizing what was changed, or "no changes needed".',
          },
        },
        required: ['summary'],
      },
    },
  },
];

export class LongTermMemory {
  private llm: LLMClient;

  constructor(llm: LLMClient) {
    this.llm = llm;
    this.ensureFileExists();
  }

  private ensureFileExists(): void {
    if (!fs.existsSync(MEMORY_FILE)) {
      fs.writeFileSync(
        MEMORY_FILE,
        `# Lexis Long-Term Memory

This file stores important facts, preferences, and recurring themes learned
from chat interactions. It is organized into sections so related facts stay
together instead of forming one long list.

## Users
Facts tied to a specific chat user: name, interests, preferences, recurring
jokes involving them. One bullet per fact, prefixed with the username, e.g.
- **someuser**: plays guitar, mentioned wanting to learn piano too

## Channel & Community
General facts about the streamer, the channel, or the community as a whole
that aren't tied to one specific user — running jokes, community culture,
recurring topics.

## Uncategorized
New entries land here by default. Once a fact's category becomes clear (e.g.
it's clearly about one user, or clearly about the channel), move it into the
right section above using edit_memory instead of leaving it here.
`,
        'utf-8'
      );
    }
  }

  load(): string {
    try {
      const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
      const stats = this.getFileStats(content);
      logger.memoryFileLoaded(stats.sizeKB, stats.lineCount);
      return content;
    } catch (error) {
      logger.error(`Failed to read MEMORY.md: ${error}`);
      return '';
    }
  }

  // Applies a str_replace-style edit: old_text must match exactly once in the current file.
  private applyEdit(oldText: string, newText: string): { ok: boolean; message: string } {
    if (!oldText) {
      return { ok: false, message: 'old_text cannot be empty. Use append_memory to add brand-new content instead.' };
    }

    let current: string;
    try {
      current = fs.readFileSync(MEMORY_FILE, 'utf-8');
    } catch (error) {
      return { ok: false, message: `Failed to read MEMORY.md: ${error}` };
    }

    const occurrences = current.split(oldText).length - 1;
    if (occurrences === 0) {
      return { ok: false, message: 'old_text was not found in MEMORY.md. Check for exact whitespace and wording, or use append_memory for new content.' };
    }
    if (occurrences > 1) {
      return { ok: false, message: `old_text appears ${occurrences} times in MEMORY.md and must be unique. Include more surrounding context to make it unique.` };
    }

    const updated = current.replace(oldText, newText);
    try {
      fs.writeFileSync(MEMORY_FILE, updated, 'utf-8');
    } catch (error) {
      return { ok: false, message: `Failed to write MEMORY.md: ${error}` };
    }

    return { ok: true, message: 'Edit applied successfully.' };
  }

  private applyAppend(text: string): { ok: boolean; message: string } {
    if (!text || !text.trim()) {
      return { ok: false, message: 'text cannot be empty.' };
    }

    try {
      const current = fs.readFileSync(MEMORY_FILE, 'utf-8');
      const uncategorizedHeader = '## Uncategorized';
      const headerIndex = current.indexOf(uncategorizedHeader);

      let updated: string;
      if (headerIndex === -1) {
        // No sectioned structure yet (e.g. an older MEMORY.md) — fall back to appending at the end.
        const separator = current.trim() === '' ? '' : '\n';
        updated = current.trimEnd() + separator + '\n' + text.trim() + '\n';
      } else {
        // Insert right after the "## Uncategorized" header line, before any existing content there.
        const insertAt = current.indexOf('\n', headerIndex) + 1;
        updated = current.slice(0, insertAt) + '\n' + text.trim() + '\n' + current.slice(insertAt);
      }

      fs.writeFileSync(MEMORY_FILE, updated, 'utf-8');
      return { ok: true, message: 'Appended to the Uncategorized section successfully.' };
    } catch (error) {
      return { ok: false, message: `Failed to write MEMORY.md: ${error}` };
    }
  }

  async consolidate(shortTermMemory: ShortTermMemory): Promise<{ saved: boolean; entriesSaved: number; fileStats: MemoryFileStats | undefined }> {
    const timeout = setTimeout(() => {
      logger.error('Memory consolidation timed out, aborting');
    }, 60000);

    try {
      logger.info('Starting memory consolidation process...');

      const recentEntries = shortTermMemory.getRecentEntries(50);
      const currentMemory = this.load();

      const conversationsText = recentEntries
        .map(entry => `${entry.username}: ${entry.userMessage}\nLexis: ${entry.botResponse}`)
        .join('\n\n');

      const systemPrompt = `You are Lexis, an AI chat bot on Twitch. You are reviewing recent conversations
to decide if anything important should be saved to your long-term memory file, MEMORY.md.

MEMORY.md is organized into sections:
- "## Users": facts tied to a specific chat user (name, interests, preferences, recurring jokes
  involving them). Each bullet should be prefixed with the username.
- "## Channel & Community": general facts about the streamer or community, not tied to one user.
- "## Uncategorized": a catch-all for new entries whose category isn't clear yet.

You have tools to edit MEMORY.md directly:
- edit_memory: replace an exact, existing piece of text. Use this to (a) correct or remove an
  outdated entry, or (b) move a fact from "## Uncategorized" into the right section once its
  category is clear, by replacing the old text with an empty string in one call and adding it to
  the target section with another edit_memory or append_memory call.
- append_memory: add a brand-new bullet point. It is inserted under "## Uncategorized" by default
  — if you already know a new fact clearly belongs under "## Users" or "## Channel & Community",
  use edit_memory instead, replacing that section's existing content with itself plus the new bullet.
- done: call this when you are finished, even if you made no changes at all.

You may call edit_memory and append_memory multiple times if needed. When you have made all the
changes you think are needed, call done. If nothing in the recent conversations is worth
remembering, just call done immediately without making any edits.

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

Be VERY selective about what you save.

ACCEPT into memory ONLY if:
- A user shares something personal about themselves (name, interests, hobbies,
  profession, location, preferences) that seems meaningful and recurring
- A user explicitly asks you to remember something specific about them
- You notice a recurring theme, inside joke, or running conversation topic
  that appears multiple times across different interactions
- A user corrects you about something and you should remember the correction
  (if this contradicts an existing entry, use edit_memory to fix it rather than
  appending a duplicate or conflicting one)
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
- The information is too vague or unclear to be useful later`;

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
      ];

      let editCount = 0;
      let isDone = false;

      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS && !isDone; iteration++) {
        const result = await this.llm.agenticToolCompletion(messages, MEMORY_EDIT_TOOLS);

        if (!result) {
          logger.warn('Consolidation step returned no result, stopping early');
          break;
        }

        if (!result.tool_calls || result.tool_calls.length === 0) {
          // Model didn't call a tool at all — treat as finished, nothing more to do.
          logger.info('Consolidation model made no tool call, ending session');
          break;
        }

        messages.push({ role: 'assistant', content: result.content, tool_calls: result.tool_calls });

        for (const toolCall of result.tool_calls) {
          const toolResult = this.executeToolCall(toolCall, () => { editCount++; });

          if (toolCall.function.name === 'done') {
            isDone = true;
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult,
          });
        }

        if (isDone) {
          logger.info('Consolidation model signaled done');
        }
      }

      if (!isDone && editCount === 0) {
        logger.warn('Consolidation stopped without calling done and without making edits');
      } else if (!isDone) {
        logger.warn(`Consolidation hit the ${MAX_TOOL_ITERATIONS}-iteration safety limit without calling done`);
      }

      // Reset the counter regardless of outcome — we've reviewed this batch either way,
      // and leaving it un-reset would immediately re-trigger consolidation on every future message.
      shortTermMemory.resetCounter();

      const fileStats = this.getFileStats();
      if (editCount > 0) {
        logger.success(`Long-term memory updated with ${editCount} edit${editCount !== 1 ? 's' : ''}`);
        logger.info(`Memory consolidation complete: MEMORY.md now ${fileStats.sizeKB.toFixed(1)} KB`);
      } else {
        logger.info('Memory consolidation complete: no changes made');
      }

      return { saved: editCount > 0, entriesSaved: editCount, fileStats };
    } finally {
      clearTimeout(timeout);
    }
  }

  private executeToolCall(toolCall: ToolCall, onEdit: () => void): string {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(toolCall.function.arguments || '{}');
    } catch (error) {
      return `Failed to parse tool arguments: ${error}`;
    }

    switch (toolCall.function.name) {
      case 'edit_memory': {
        const oldText = String(args.old_text ?? '');
        const newText = String(args.new_text ?? '');
        const result = this.applyEdit(oldText, newText);
        if (result.ok) onEdit();
        logger.info(`[MEM] edit_memory: ${result.ok ? 'OK' : 'FAILED - ' + result.message}`);
        return result.message;
      }
      case 'append_memory': {
        const text = String(args.text ?? '');
        const result = this.applyAppend(text);
        if (result.ok) onEdit();
        logger.info(`[MEM] append_memory: ${result.ok ? 'OK' : 'FAILED - ' + result.message}`);
        return result.message;
      }
      case 'done': {
        const summary = String(args.summary ?? '');
        return `Session ended: ${summary}`;
      }
      default:
        return `Unknown tool: ${toolCall.function.name}`;
    }
  }

  private getFileStats(content?: string): MemoryFileStats {
    const fileContent = content ?? fs.readFileSync(MEMORY_FILE, 'utf-8');
    const sizeKB = fileContent.length / 1024;
    const lineCount = fileContent.split('\n').length;
    const sectionCount = (fileContent.match(/^##\s/gm) || []).length;
    return { sizeKB, lineCount, sectionCount };
  }
}
