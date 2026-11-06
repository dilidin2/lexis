import * as fs from 'fs';
import * as path from 'path';
import { BotConfig } from '../config';
import { logger } from '../logger';

export interface ShortTermMemoryEntry {
  // Monotonic id, survives eviction — used as the consolidation watermark.
  id: number;
  username: string;
  userMessage: string;
  botResponse: string;
}

export interface ShortTermMemoryData {
  entries: ShortTermMemoryEntry[];
  consolidationCounter: number;
  lastConsolidatedId: number;
}

const MEMORY_FILE = path.join(__dirname, '..', '..', 'short_term_memory.json');

export class ShortTermMemory {
  private entries: ShortTermMemoryEntry[] = [];
  private consolidationCounter: number = 0;
  private lastConsolidatedId: number = 0;
  private nextId: number = 1;
  private maxSize: number;

  constructor(config: BotConfig) {
    this.maxSize = config.shortTermMemorySize;
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(MEMORY_FILE)) {
        const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
        const data = JSON.parse(content) as ShortTermMemoryData;
        const rawEntries = data.entries ?? [];
        // Migration: entries from older versions have no id — assign them
        // sequential ids in order.
        this.entries = rawEntries.map((e, i) => ({
          id: e.id ?? i + 1,
          username: e.username,
          userMessage: e.userMessage,
          botResponse: e.botResponse,
        }));
        this.consolidationCounter = data.consolidationCounter ?? 0;
        this.lastConsolidatedId = data.lastConsolidatedId ?? 0;
        this.nextId = this.entries.length ? Math.max(...this.entries.map(e => e.id)) + 1 : 1;
        logger.info(`Loaded ${this.entries.length} short-term memory entries, counter: ${this.consolidationCounter}, watermark: ${this.lastConsolidatedId}`);
      }
    } catch (error) {
      logger.error(`Failed to load short-term memory: ${error}`);
      this.entries = [];
      this.consolidationCounter = 0;
      this.lastConsolidatedId = 0;
      this.nextId = 1;
    }
  }

  private save(): void {
    try {
      const data: ShortTermMemoryData = {
        entries: this.entries,
        consolidationCounter: this.consolidationCounter,
        lastConsolidatedId: this.lastConsolidatedId,
      };
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      logger.error(`Failed to save short-term memory: ${error}`);
    }
  }

  addEntry(username: string, userMessage: string, botResponse: string): void {
    const entry: ShortTermMemoryEntry = {
      id: this.nextId++,
      username,
      userMessage,
      botResponse,
    };

    this.entries.push(entry);

    // Evict oldest entries if over limit
    while (this.entries.length > this.maxSize) {
      this.entries.shift();
    }

    this.consolidationCounter++;
    this.save();
  }

  incrementCounter(): void {
    this.consolidationCounter++;
    this.save();
  }

  resetCounter(): void {
    this.consolidationCounter = 0;
    this.save();
  }

  shouldConsolidate(interval: number): boolean {
    return this.consolidationCounter >= interval;
  }

  getEntries(): ShortTermMemoryEntry[] {
    return [...this.entries];
  }

  getRecentEntries(count: number): ShortTermMemoryEntry[] {
    return this.entries.slice(-count);
  }

  /** Entries added after the given watermark id (oldest first). */
  getEntriesSince(sinceId: number): ShortTermMemoryEntry[] {
    return this.entries.filter(e => e.id > sinceId);
  }

  /** Id of the most recent entry, or 0 if there are none. */
  getLastEntryId(): number {
    return this.entries.length ? this.entries[this.entries.length - 1].id : 0;
  }

  getLastConsolidatedId(): number {
    return this.lastConsolidatedId;
  }

  /** Advance the consolidation watermark to the given entry id. */
  markConsolidated(id: number): void {
    if (id > this.lastConsolidatedId) {
      this.lastConsolidatedId = id;
      this.save();
    }
  }

  getConsolidationCounter(): number {
    return this.consolidationCounter;
  }

  formatForLLM(): string {
    if (this.entries.length === 0) {
      return '';
    }

    const lines = ['Recent conversations:'];
    for (const entry of this.entries) {
      lines.push(`${entry.username}: ${entry.userMessage}`);
      lines.push(`Lexis: ${entry.botResponse}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  flush(): void {
    this.save();
  }
}
