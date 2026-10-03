import { Config } from '../config';
import { LLMClient, ChatMessage, ToolDefinition } from '../llm/client';
import { ShortTermMemory } from '../memory/shortTerm';
import { LongTermMemory } from '../memory/longTerm';
import { HelixClient } from '../twitch/helix';
import { loadSystemPrompt } from '../prompts/loader';
import { cleanResponse } from '../utils/response';
import { logger } from '../logger';

const RESPOND_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'respond_in_chat',
    description:
      'Send a spontaneous message to the Twitch chat. Only call this if you genuinely ' +
      'have something worth adding to the ongoing conversation. Do NOT call it if you ' +
      'have nothing to add — staying silent is the right answer most of the time.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message to send to chat. Plain text, no markdown, keep it short.',
        },
      },
      required: ['message'],
    },
  },
};

/**
 * The internal "check-in" question appended to the conversation context.
 * The model answers it implicitly: calling respond_in_chat means "yes, here
 * is my message", no tool call means "no, nothing to add".
 */
const AUTONOMY_QUESTION =
  '[Internal check-in] Do you want to add something to the conversation? ' +
  'If yes, call the respond_in_chat tool with your message. If no, do not call any tool.';

function buildAutonomyRules(maxResponseLength: number): string {
  return [
    '=== AUTONOMY RULES ===',
    'You are checking in on the chat on your own initiative, not because a user asked you.',
    'Think of yourself as a real person in the chat who decides to jump in.',
    '',
    'You SHOULD add a short message when:',
    '- A user just said something that deserves a reaction (agree, disagree, joke, add info).',
    '- The chat is discussing a topic you can naturally contribute to.',
    '- The conversation is slowing down and you can revive it.',
    '',
    'You MUST stay silent when:',
    '- You already commented on this exact topic. Check the history, including your own',
    '  spontaneous messages (marked "lexis: (spontaneous)"). If nothing new happened since',
    '  your last message on the topic, say nothing — do not answer the same person twice',
    '  on the same topic.',
    '- The conversation is already flowing well without you.',
    '',
    'Language: always write in the same language the chat is currently using. If the chat',
    'is in Italian, write in Italian; if in English, write in English. Match the chat\'s tone.',
    '',
    'Format: short (under ' + maxResponseLength + ' characters), plain text, no markdown, no',
    '@username, and never start your message with "Lexis:" (that prefix only appears in',
    'the history).',
    '=== END AUTONOMY RULES ===',
  ].join('\n');
}

export class AutonomyManager {
  private config: Config;
  private llm: LLMClient;
  private shortTermMemory: ShortTermMemory;
  private longTermMemory: LongTermMemory;
  private helix: HelixClient;
  private isBusy: () => boolean;
  private personalityPrompt: string;
  private timer: NodeJS.Timeout | null = null;
  private evaluating = false;
  private lastMessageTime = 0;

  constructor(
    config: Config,
    llm: LLMClient,
    shortTermMemory: ShortTermMemory,
    longTermMemory: LongTermMemory,
    helix: HelixClient,
    isBusy: () => boolean
  ) {
    this.config = config;
    this.llm = llm;
    this.shortTermMemory = shortTermMemory;
    this.longTermMemory = longTermMemory;
    this.helix = helix;
    this.isBusy = isBusy;
    this.personalityPrompt = loadSystemPrompt(config.bot.systemPromptFile);
  }

  start(): void {
    const a = this.config.bot.autonomy;
    if (!a.enabled) {
      logger.info('Autonomy is disabled');
      return;
    }
    logger.info(
      `Autonomy enabled: checks every ${Math.round(a.intervalMs / 1000)}s, ` +
      `min gap between autonomous messages ${Math.round(a.cooldownMs / 1000)}s`
    );
    this.timer = setInterval(() => {
      void this.evaluate();
    }, a.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private buildSystemPrompt(): string {
    const parts: string[] = [this.personalityPrompt];

    const longTermContent = this.longTermMemory.load();
    if (longTermContent.trim()) {
      parts.push('');
      parts.push('=== LONG-TERM MEMORY ===');
      parts.push(longTermContent.trim());
      parts.push('=== END LONG-TERM MEMORY ===');
    }

    parts.push('');
    parts.push(buildAutonomyRules(this.config.bot.autonomy.maxResponseLength));

    return parts.join('\n');
  }

  private async evaluate(): Promise<void> {
    const a = this.config.bot.autonomy;

    if (this.evaluating) return;
    if (this.isBusy()) {
      logger.info('Autonomy check skipped: bot is busy');
      return;
    }
    if (Date.now() - this.lastMessageTime < a.cooldownMs) {
      logger.info('Autonomy check skipped: still in autonomous cooldown');
      return;
    }
    const entries = this.shortTermMemory.getRecentEntries(a.recentContextEntries);
    if (entries.length < a.minRecentEntries) {
      logger.info(`Autonomy check skipped: not enough recent conversation (${entries.length}/${a.minRecentEntries})`);
      return;
    }

    this.evaluating = true;
    try {
      const messages: ChatMessage[] = [{ role: 'system', content: this.buildSystemPrompt() }];
      for (const entry of entries) {
        messages.push({ role: 'user', content: `${entry.username}: ${entry.userMessage}` });
        messages.push({ role: 'assistant', content: entry.botResponse });
      }
      messages.push({ role: 'user', content: AUTONOMY_QUESTION });

      const result = await this.llm.agenticToolCompletion(messages, [RESPOND_TOOL], 0.8);
      if (!result) {
        logger.info('Autonomy check: LLM returned no result');
        return;
      }

      const call = result.tool_calls?.find((t) => t.function.name === 'respond_in_chat');
      if (!call) {
        logger.info('Autonomy check: nothing to add');
        return;
      }

      let message: string;
      try {
        const args = JSON.parse(call.function.arguments);
        message = (args.message as string) ?? '';
      } catch (error) {
        logger.error(`Autonomy: invalid tool arguments: ${call.function.arguments}`);
        return;
      }

      message = cleanResponse(message, a.maxResponseLength);
      if (!message) return;

      const sent = await this.helix.sendMessage(
        this.config.twitch.channelUserId,
        this.helix.getBotUserId(),
        message
      );

      if (sent) {
        this.lastMessageTime = Date.now();
        // Store in short-term memory so future !bot responses know the bot
        // spoke on its own initiative (and can reference it).
        this.shortTermMemory.addEntry('lexis', '(spontaneous)', message);
        logger.info(`Autonomy: sent "${message}"`);
      } else {
        logger.info('Autonomy: failed to send message');
      }
    } catch (error) {
      logger.error(`Autonomy check failed: ${error}`);
    } finally {
      this.evaluating = false;
    }
  }
}
