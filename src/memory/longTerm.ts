import * as fs from 'fs';
import * as path from 'path';
import { LLMClient, ChatMessage, ToolDefinition, ToolCall } from '../llm/client';
import { ShortTermMemory } from './shortTerm';
import { logger, MemoryFileStats } from '../logger';

const FACTS_FILE = path.join(__dirname, '..', '..', 'facts.json');
const MEMORY_FILE = path.join(__dirname, '..', '..', 'MEMORY.md');
const MAX_TOOL_ITERATIONS = 8;
const MAX_FACTS_PER_SUBJECT = 12;
const MAX_TOTAL_FACTS = 200;
// Consolidation edits involve reading the fact list back out, so it needs a
// bigger output budget than normal agentic calls.
const CONSOLIDATION_MAX_TOKENS = 4000;

export interface MemoryFact {
  id: number;
  subject: string; // username, "channel", or "general"
  fact: string;
  updatedAt: number;
}

interface FactsData {
  facts: MemoryFact[];
  nextId: number;
}

const MEMORY_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'add_fact',
      description:
        'Add a new short fact to long-term memory. subject must be the exact username, ' +
        '"channel" (streamer/channel culture), or "general". Do not add facts that are ' +
        'already covered by an existing fact — use update_fact to merge instead.',
      parameters: {
        type: 'object',
        properties: {
          subject: {
            type: 'string',
            description: 'Username, "channel", or "general".',
          },
          fact: {
            type: 'string',
            description: 'One short, self-contained fact (under 25 words).',
          },
        },
        required: ['subject', 'fact'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_fact',
      description:
        'Replace the text of an existing fact, given its id. Use this to merge new ' +
        'information into an existing fact or to correct it.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Id of the fact to update.' },
          fact: {
            type: 'string',
            description: 'The new full text of the fact (under 25 words).',
          },
        },
        required: ['id', 'fact'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_fact',
      description: 'Delete an existing fact, given its id. Use for outdated or contradicted facts.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Id of the fact to remove.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description:
        'Call this when you are finished, even if you made no changes. This ends the ' +
        'memory consolidation session.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'One short sentence summarizing what changed, or "no changes needed".',
          },
        },
        required: ['summary'],
      },
    },
  },
];

export class LongTermMemory {
  private llm: LLMClient;
  private facts: MemoryFact[] = [];
  private nextId = 1;

  constructor(llm: LLMClient) {
    this.llm = llm;
    this.loadFacts();
  }

  private loadFacts(): void {
    try {
      if (fs.existsSync(FACTS_FILE)) {
        const data = JSON.parse(fs.readFileSync(FACTS_FILE, 'utf-8')) as FactsData;
        this.facts = data.facts ?? [];
        this.nextId = data.nextId ?? (this.facts.length ? Math.max(...this.facts.map(f => f.id)) + 1 : 1);
      } else {
        this.save(); // create facts.json and render MEMORY.md
      }
    } catch (error) {
      logger.error(`Failed to load facts: ${error}`);
      this.facts = [];
      this.nextId = 1;
    }
  }

  private save(): void {
    try {
      const data: FactsData = { facts: this.facts, nextId: this.nextId };
      fs.writeFileSync(FACTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
      fs.writeFileSync(MEMORY_FILE, this.renderMarkdown(), 'utf-8');
    } catch (error) {
      logger.error(`Failed to save facts: ${error}`);
    }
  }

  /** Rendered fact list for LLM context (system prompts). */
  load(): string {
    if (this.facts.length === 0) return '';
    return this.facts
      .slice()
      .sort((a, b) => a.subject.localeCompare(b.subject) || a.id - b.id)
      .map(f => `[${f.id}] ${f.subject}: ${f.fact}`)
      .join('\n');
  }

  /** Human-readable MEMORY.md, grouped by section. */
  private renderMarkdown(): string {
    const users = this.facts.filter(f => f.subject !== 'channel' && f.subject !== 'general');
    const channel = this.facts.filter(f => f.subject === 'channel');
    const general = this.facts.filter(f => f.subject === 'general');

    const bullet = (f: MemoryFact) => `- **${f.subject}** [${f.id}]: ${f.fact}`;

    return [
      '# Lexis Long-Term Memory',
      '',
      'Auto-maintained by Lexis from chat conversations. The source of truth is',
      '`facts.json` — let Lexis consolidate rather than editing this file by hand.',
      '',
      '## Users',
      users.length ? users.map(bullet).join('\n') : '(none yet)',
      '',
      '## Channel & Community',
      channel.length ? channel.map(bullet).join('\n') : '(none yet)',
      '',
      '## General',
      general.length ? general.map(bullet).join('\n') : '(none yet)',
      '',
    ].join('\n');
  }

  private factCountForSubject(subject: string): number {
    return this.facts.filter(f => f.subject === subject).length;
  }

  private addFact(subject: string, fact: string): { ok: boolean; message: string } {
    subject = subject.trim();
    fact = fact.trim();
    if (!subject || !fact) return { ok: false, message: 'subject and fact cannot be empty.' };

    if (this.factCountForSubject(subject) >= MAX_FACTS_PER_SUBJECT) {
      return {
        ok: false,
        message: `Subject "${subject}" already has ${MAX_FACTS_PER_SUBJECT} facts. Merge into an ` +
          `existing fact with update_fact or remove_fact an outdated one first.`,
      };
    }

    // Global cap: evict the stalest fact (oldest updatedAt) to make room.
    if (this.facts.length >= MAX_TOTAL_FACTS) {
      const stalest = this.facts.reduce((min, f) => (f.updatedAt < min.updatedAt ? f : min));
      this.facts = this.facts.filter(f => f.id !== stalest.id);
      logger.info(`Memory cap reached, evicted stalest fact [${stalest.id}] ${stalest.subject}: ${stalest.fact}`);
    }

    const newFact: MemoryFact = { id: this.nextId++, subject, fact, updatedAt: Date.now() };
    this.facts.push(newFact);
    return { ok: true, message: `Fact added as [${newFact.id}] ${subject}: ${fact}` };
  }

  private updateFact(id: number, fact: string): { ok: boolean; message: string } {
    fact = fact.trim();
    if (!fact) return { ok: false, message: 'fact cannot be empty.' };
    const existing = this.facts.find(f => f.id === id);
    if (!existing) {
      return { ok: false, message: `No fact with id ${id}. Current ids: ${this.facts.map(f => f.id).join(', ') || '(none)'}` };
    }
    existing.fact = fact;
    existing.updatedAt = Date.now();
    return { ok: true, message: `Fact [${id}] updated: ${fact}` };
  }

  private removeFact(id: number): { ok: boolean; message: string } {
    const existing = this.facts.find(f => f.id === id);
    if (!existing) {
      return { ok: false, message: `No fact with id ${id}. Current ids: ${this.facts.map(f => f.id).join(', ') || '(none)'}` };
    }
    this.facts = this.facts.filter(f => f.id !== id);
    return { ok: true, message: `Fact [${id}] removed.` };
  }

  async consolidate(shortTermMemory: ShortTermMemory): Promise<{ saved: boolean; entriesSaved: number; fileStats: MemoryFileStats | undefined }> {
    try {
      // Watermark: only review entries that arrived since the last
      // consolidation, instead of re-reading the same sliding window.
      const sinceId = shortTermMemory.getLastConsolidatedId();
      const recentEntries = shortTermMemory.getEntriesSince(sinceId);

      if (recentEntries.length === 0) {
        logger.info('Memory consolidation: no new entries to review');
        shortTermMemory.resetCounter();
        return { saved: false, entriesSaved: 0, fileStats: this.getFileStats() };
      }

      logger.info(`Starting memory consolidation for ${recentEntries.length} new entries...`);

      const conversationsText = recentEntries
        .map(entry => `${entry.username}: ${entry.userMessage}\nLexis: ${entry.botResponse}`)
        .join('\n\n');

      const factsList = this.load() || '(no facts stored yet)';

      const systemPrompt = `You are Lexis, an AI chat bot on Twitch. You are maintaining your long-term
memory: a list of short facts about chat users, the channel, and general topics.

CURRENT FACTS (id | subject: fact):
${factsList}

NEW CONVERSATIONS since your last review:
${conversationsText}

Decide what from the new conversations is worth remembering long-term.

Save with add_fact ONLY durable facts:
- personal info, preferences, or interests a user shares that seem meaningful and recurring
- explicit "remember this" requests
- running jokes / inside jokes that appear across multiple interactions
- significant events (birthdays, achievements, milestones)
- channel culture (subject "channel")

Do NOT save: one-off Q&A, greetings, banter, throwaway remarks, trends that will date
quickly, vague information, or anything already covered by an existing fact.

Rules:
- One fact per entry; keep each fact under 25 words and self-contained.
- If a related fact already exists, prefer update_fact (merge into it) over add_fact.
- Use update_fact to correct a fact the conversation contradicts.
- Use remove_fact for facts that are outdated.
- subject must be the exact username, or "channel", or "general".
- When you are done, call done. If nothing is worth saving, call done immediately.`;

      const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];

      let editCount = 0;
      let isDone = false;

      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS && !isDone; iteration++) {
        const result = await this.llm.agenticToolCompletion(messages, MEMORY_TOOLS, 0.3, CONSOLIDATION_MAX_TOKENS);

        if (!result) {
          logger.warn('Consolidation step returned no result, stopping early');
          break;
        }

        if (!result.tool_calls || result.tool_calls.length === 0) {
          logger.info('Consolidation model made no tool call, ending session');
          break;
        }

        messages.push({ role: 'assistant', content: result.content, tool_calls: result.tool_calls });

        for (const toolCall of result.tool_calls) {
          const toolResult = this.executeToolCall(toolCall, () => { editCount++; });
          if (toolCall.function.name === 'done') {
            isDone = true;
          }
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult });
        }
      }

      if (!isDone && editCount === 0) {
        logger.warn('Consolidation stopped without calling done and without making edits');
      } else if (!isDone) {
        logger.warn(`Consolidation hit the ${MAX_TOOL_ITERATIONS}-iteration safety limit without calling done`);
      }

      // We reviewed this batch: advance the watermark and reset the counter.
      shortTermMemory.markConsolidated(recentEntries[recentEntries.length - 1].id);
      shortTermMemory.resetCounter();

      if (editCount > 0) this.save();

      const fileStats = this.getFileStats();
      if (editCount > 0) {
        logger.success(`Long-term memory updated with ${editCount} change${editCount !== 1 ? 's' : ''}`);
        logger.info(`Memory consolidation complete: ${this.facts.length} facts total`);
      } else {
        logger.info('Memory consolidation complete: no changes made');
      }

      return { saved: editCount > 0, entriesSaved: editCount, fileStats };
    } catch (error) {
      logger.error(`Memory consolidation failed: ${error}`);
      shortTermMemory.resetCounter();
      return { saved: false, entriesSaved: 0, fileStats: this.getFileStats() };
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
      case 'add_fact': {
        const result = this.addFact(String(args.subject ?? ''), String(args.fact ?? ''));
        if (result.ok) onEdit();
        logger.info(`[MEM] add_fact: ${result.ok ? 'OK' : 'FAILED - ' + result.message}`);
        return result.message;
      }
      case 'update_fact': {
        const result = this.updateFact(Number(args.id ?? -1), String(args.fact ?? ''));
        if (result.ok) onEdit();
        logger.info(`[MEM] update_fact: ${result.ok ? 'OK' : 'FAILED - ' + result.message}`);
        return result.message;
      }
      case 'remove_fact': {
        const result = this.removeFact(Number(args.id ?? -1));
        if (result.ok) onEdit();
        logger.info(`[MEM] remove_fact: ${result.ok ? 'OK' : 'FAILED - ' + result.message}`);
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

  private getFileStats(): MemoryFileStats {
    const content = this.renderMarkdown();
    return {
      sizeKB: content.length / 1024,
      lineCount: content.split('\n').length,
      sectionCount: (content.match(/^##\s/gm) || []).length,
    };
  }

  flush(): void {
    this.save();
  }
}
