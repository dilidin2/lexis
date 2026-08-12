import { Config } from '../config';
import { LLMClient, ChatMessage } from '../llm/client';
import { ShortTermMemory } from '../memory/shortTerm';
import { LongTermMemory } from '../memory/longTerm';
import { loadSystemPrompt, buildFullSystemPrompt } from '../prompts/loader';
import { HelixClient } from '../twitch/helix';
import { ChatMessageEvent } from '../twitch/websocket';

interface QueuedCommand {
  event: ChatMessageEvent;
  timestamp: number;
}

interface UserCooldowns {
  [userId: string]: number;
}

const MAX_QUEUE_SIZE = 50;

export class CommandHandler {
  private config: Config;
  private llm: LLMClient;
  private shortTermMemory: ShortTermMemory;
  private longTermMemory: LongTermMemory;
  private helix: HelixClient;
  private lastResponseTime: number = 0;
  private userCooldowns: UserCooldowns = {};
  private commandQueue: QueuedCommand[] = [];
  private isProcessing = false;
  private isConsolidating = false;
  private personalityPrompt: string;
  private readonly commandPattern: RegExp;

  constructor(
    config: Config,
    llm: LLMClient,
    shortTermMemory: ShortTermMemory,
    longTermMemory: LongTermMemory,
    helix: HelixClient
  ) {
    this.config = config;
    this.llm = llm;
    this.shortTermMemory = shortTermMemory;
    this.longTermMemory = longTermMemory;
    this.helix = helix;
    this.personalityPrompt = loadSystemPrompt(config.bot.systemPromptFile);
    // Remove leading ! or / from configured prefix so we can prepend [!/] in the regex
    const prefix = config.bot.commandPrefix.replace(/^[!\/]/, '');
    this.commandPattern = new RegExp(`^[!/]${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(.+)$`, 'i');
    console.log(`[INFO] Command pattern: ${this.commandPattern}`);
  }

  handleEvent(event: ChatMessageEvent): void {
    const match = event.message.text.match(this.commandPattern);
    if (!match) {
      return;
    }

    const userMessage = match[1].trim();
    const userId = event.chatter_user_id;

    // Check per-user cooldown
    const now = Date.now();
    if (this.userCooldowns[userId] && now - this.userCooldowns[userId] < 5000) {
      return;
    }

    // Set user cooldown
    this.userCooldowns[userId] = now;

    // If consolidating, queue the command
    if (this.isConsolidating) {
      this.enqueueCommand(event);
      return;
    }

    // Queue the command for processing
    this.enqueueCommand(event);
    this.processQueue();
  }

  private enqueueCommand(event: ChatMessageEvent): void {
    if (this.commandQueue.length >= MAX_QUEUE_SIZE) {
      console.warn('[WARN] Command queue full, dropping oldest command');
      this.commandQueue.shift();
    }

    this.commandQueue.push({
      event,
      timestamp: Date.now(),
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.isConsolidating) {
      return;
    }

    while (this.commandQueue.length > 0) {
      this.isProcessing = true;
      const queued = this.commandQueue.shift();
      if (!queued) break;

      await this.processCommand(queued.event);
      this.isProcessing = false;

      // Check if consolidation is needed after each command
      if (this.shortTermMemory.shouldConsolidate(this.config.bot.longTermMemoryInterval)) {
        await this.runConsolidation();
      }
    }
  }

  private async processCommand(event: ChatMessageEvent): Promise<void> {
    const match = event.message.text.match(this.commandPattern);
    if (!match) return;

    const username = event.chatter_user_login;
    const userMessage = match[1].trim();

    // Check global rate limit
    const now = Date.now();
    if (now - this.lastResponseTime < this.config.bot.rateLimitMs) {
      const waitTime = this.config.bot.rateLimitMs - (now - this.lastResponseTime);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    // Build system prompt with current memory
    const longTermContent = this.longTermMemory.load();
    const systemPrompt = buildFullSystemPrompt(
      this.personalityPrompt,
      longTermContent,
      this.config.bot.maxResponseLength
    );

    // Build conversation messages
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Add short-term memory as conversation history
    const entries = this.shortTermMemory.getEntries();
    for (const entry of entries) {
      messages.push({ role: 'user', content: `${entry.username}: ${entry.userMessage}` });
      messages.push({ role: 'assistant', content: entry.botResponse });
    }

    // Add current message
    messages.push({ role: 'user', content: `${username}: ${userMessage}` });

    // Call LLM
    const rawResponse = await this.llm.chatCompletion(messages);
    if (!rawResponse) {
      console.warn('[WARN] LLM returned no response, skipping command');
      return;
    }

    // Process response
    const response = this.processResponse(rawResponse);

    // Send response
    const sent = await this.helix.sendMessage(
      this.config.twitch.channelUserId,
      this.helix.getBotUserId(),
      response
    );

    if (sent) {
      this.lastResponseTime = Date.now();
      this.shortTermMemory.addEntry(username, userMessage, response);
    }
  }

  private processResponse(raw: string): string {
    // Remove markdown formatting
    let response = raw
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/`(.*?)`/g, '$1')
      .replace(/~~(.*?)~~/g, '$1')
      .replace(/#{1,6}\s/g, '')
      .replace(/\n+/g, ' ')
      .trim();

    // Truncate if needed
    const maxLength = this.config.bot.maxResponseLength;
    if (response.length > maxLength) {
      response = response.substring(0, maxLength);
      // Don't end mid-word
      const lastSpace = response.lastIndexOf(' ');
      if (lastSpace > maxLength * 0.7) {
        response = response.substring(0, lastSpace);
      }
      response = response.trim() + '...';
    }

    return response;
  }

  private async runConsolidation(): Promise<void> {
    this.isConsolidating = true;
    const queuedCount = this.commandQueue.length;
    console.log(`[INFO] Memory consolidation started, queuing incoming commands`);

    await this.longTermMemory.consolidate(this.shortTermMemory);

    this.isConsolidating = false;
    console.log(`[INFO] Memory consolidation complete, processing ${queuedCount} queued commands`);

    this.processQueue();
  }

  flush(): void {
    this.shortTermMemory.flush();
  }
}
