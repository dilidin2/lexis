import * as fs from 'fs';
import * as path from 'path';
import { BotConfig } from '../config';

export interface ShortTermMemoryEntry {
  username: string;
  userMessage: string;
  botResponse: string;
}

export interface ShortTermMemoryData {
  entries: ShortTermMemoryEntry[];
  consolidationCounter: number;
}

const MEMORY_FILE = path.join(__dirname, '..', '..', 'short_term_memory.json');

export class ShortTermMemory {
  private entries: ShortTermMemoryEntry[] = [];
  private consolidationCounter: number = 0;
  private maxSize: number;
  private saveTimeout: NodeJS.Timeout | null = null;
  private readonly SAVE_DEBOUNCE_MS = 5000;

  constructor(config: BotConfig) {
    this.maxSize = config.shortTermMemorySize;
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(MEMORY_FILE)) {
        const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
        const data = JSON.parse(content) as ShortTermMemoryData;
        this.entries = data.entries ?? [];
        this.consolidationCounter = data.consolidationCounter ?? 0;
        console.log(`[INFO] Loaded ${this.entries.length} short-term memory entries, counter: ${this.consolidationCounter}`);
      }
    } catch (error) {
      console.error(`[ERROR] Failed to load short-term memory: ${error}`);
      this.entries = [];
      this.consolidationCounter = 0;
    }
  }

  private save(): void {
    try {
      const data: ShortTermMemoryData = {
        entries: this.entries,
        consolidationCounter: this.consolidationCounter,
      };
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      console.error(`[ERROR] Failed to save short-term memory: ${error}`);
    }
  }

  private debouncedSave(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      this.save();
      this.saveTimeout = null;
    }, this.SAVE_DEBOUNCE_MS);
  }

  addEntry(username: string, userMessage: string, botResponse: string): void {
    const entry: ShortTermMemoryEntry = {
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
    this.debouncedSave();
  }

  incrementCounter(): void {
    this.consolidationCounter++;
    this.debouncedSave();
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
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.save();
  }
}
