import { Config } from '../config';
import { LLMClient, ChatMessage } from '../llm/client';
import { ShortTermMemory } from '../memory/shortTerm';
import { LongTermMemory } from '../memory/longTerm';
import { loadSystemPrompt, buildFullSystemPrompt } from '../prompts/loader';
import { HelixClient } from '../twitch/helix';
import { ChatMessageEvent } from '../twitch/websocket';
import { logger, MemoryFileStats } from '../logger';
import { RollingWindowRateLimiter } from '../rateLimiter';

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
  private globalLimiter: RollingWindowRateLimiter;
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
    this.globalLimiter = new RollingWindowRateLimiter(
      config.bot.maxRequestsPerWindow,
      config.bot.windowMs
    );
    this.personalityPrompt = loadSystemPrompt(config.bot.systemPromptFile);
    // Remove leading ! or / from configured prefix so we can prepend [!/] in the regex
    const prefix = config.bot.commandPrefix.replace(/^[!\/]/, '');
    this.commandPattern = new RegExp(`^[!/]${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(.+)$`, 'i');
    logger.info(`Command pattern: ${this.commandPattern}`);
  }

  handleEvent(event: ChatMessageEvent): void {
    const match = event.message.text.match(this.commandPattern);
    if (!match) {
      return;
    }

    const userMessage = match[1].trim();
    const userId = event.chatter_user_id;
    const username = event.chatter_user_login;

    // Log received message
    logger.chatMessage(username, userMessage, event.message_id);

    // Check per-user cooldown
    const now = Date.now();
    const userCooldownMs = this.config.bot.userCooldownMs;
    if (this.userCooldowns[userId] && now - this.userCooldowns[userId] < userCooldownMs) {
      const remaining = userCooldownMs - (now - this.userCooldowns[userId]);
      logger.cooldownHit(username, remaining);
      return;
    }

    // Check message length
    if (userMessage.length > 400) {
      logger.messageRejected(username, 'Message too long', `${userMessage.length}/400 chars`);
      return;
    }

    // Check global LLM rate limit (protects the local GPU from spam)
    const windowWaitMs = this.globalLimiter.waitTime(now);
    if (windowWaitMs > 0) {
      // Still apply the per-user cooldown so it can't be retried right away,
      // and drop the request instead of queueing it up into a long GPU grind
      this.userCooldowns[userId] = now;
      logger.rateLimited(
        username,
        this.globalLimiter.pending(now),
        this.globalLimiter.maxRequests,
        this.globalLimiter.windowMs
      );
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
      logger.warn('Command queue full, dropping oldest command');
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

      try {
        await this.processCommand(queued.event);
      } catch (error) {
        // A single bad command must never take the whole bot down
        // (this method is fire-and-forget; an uncaught error here would
        // become an unhandled rejection and crash the process).
        console.error(`[ERROR] Failed to process command from ${queued.event.chatter_user_login}: ${error}`);
      }
      this.isProcessing = false;

      // Check if consolidation is needed after each command
      if (this.shortTermMemory.shouldConsolidate(this.config.bot.longTermMemoryInterval)) {
        try {
          await this.runConsolidation();
        } catch (error) {
          console.error(`[ERROR] Memory consolidation failed: ${error}`);
        }
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

    // Check context size (rough estimate: ~4 chars per token)
    const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    const estimatedTokens = Math.round(totalChars / 4);
    const maxTokens = 128000; // typical context window
    const contextPercent = (estimatedTokens / maxTokens) * 100;
    if (contextPercent > 75) {
      logger.contextWarning(estimatedTokens, maxTokens, contextPercent);
    }

    // Call LLM
    const rawResponse = await this.llm.chatCompletion(messages);
    if (!rawResponse) {
      logger.messageRejected(username, 'LLM returned no response');
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
      logger.llmResponse(username, response);
    } else {
      logger.messageRejected(username, 'Failed to send response');
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
      const originalLength = response.length;
      response = response.substring(0, maxLength);
      // Don't end mid-word
      const lastSpace = response.lastIndexOf(' ');
      if (lastSpace > maxLength * 0.7) {
        response = response.substring(0, lastSpace);
      }
      response = response.trim() + '...';
      logger.responseTruncated(originalLength, response.length, `exceeded ${maxLength} char limit`);
    }

    return response;
  }

  private async runConsolidation(): Promise<void> {
    interface ConsolidationResult {
      saved: boolean;
      entriesSaved: number;
      fileStats: MemoryFileStats | undefined;
    }

    this.isConsolidating = true;
    this.isConsolidating = true;
    const queuedCount = this.commandQueue.length;
    const entriesCount = this.shortTermMemory.getEntries().length;
    const counter = this.shortTermMemory.getConsolidationCounter();
    const interval = this.config.bot.longTermMemoryInterval;

    logger.memoryConsolidationStart(entriesCount, counter, interval);

    const startTime = Date.now();
    const result: ConsolidationResult = await this.longTermMemory.consolidate(this.shortTermMemory);
    const durationMs = Date.now() - startTime;

    this.isConsolidating = false;
    logger.memoryConsolidationEnd(
      result.saved,
      result.entriesSaved,
      durationMs,
      result.fileStats
    );

    if (queuedCount > 0) {
      logger.info(`Processing ${queuedCount} queued commands`);
    }
    this.processQueue();
  }

  flush(): void {
    this.shortTermMemory.flush();
  }
}
