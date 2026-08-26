import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_TWITCH_CLIENT_ID = "2ywxbkhvxpz1b917h7b0siinuz11ii";

export interface TwitchConfig {
  channelUserId: string;
}

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeout: number;
}

export interface BotConfig {
  commandPrefix: string;
  maxResponseLength: number;
  rateLimitMs: number;
  userCooldownMs: number;
  maxRequestsPerWindow: number;
  windowMs: number;
  shortTermMemorySize: number;
  longTermMemoryInterval: number;
  systemPromptFile: string;
}

export interface Config {
  twitch: TwitchConfig;
  llm: LLMConfig;
  bot: BotConfig;
}

function loadConfigFile(): Partial<Config> {
  const configPath = path.join(__dirname, '..', 'config.json');
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`[ERROR] Failed to load config.json: ${error}`);
    return {};
  }
}

export function loadConfig(): Config {
  const fileConfig = loadConfigFile();

  return {
    twitch: {
      channelUserId: process.env.TWITCH_CHANNEL_USER_ID ?? fileConfig.twitch?.channelUserId ?? '',
    },
    llm: {
      baseUrl: process.env.LLM_BASE_URL ?? fileConfig.llm?.baseUrl ?? 'http://0.0.0.0:8099/v1',
      apiKey: process.env.LLM_API_KEY ?? fileConfig.llm?.apiKey ?? 'no-key',
      model: process.env.LLM_MODEL ?? fileConfig.llm?.model ?? 'gpt-3.5-turbo',
      temperature: fileConfig.llm?.temperature ?? 0.7,
      maxTokens: fileConfig.llm?.maxTokens ?? 500,
      timeout: fileConfig.llm?.timeout ?? 30000,
    },
    bot: {
      commandPrefix: fileConfig.bot?.commandPrefix ?? '!bot',
      maxResponseLength: fileConfig.bot?.maxResponseLength ?? 400,
      rateLimitMs: fileConfig.bot?.rateLimitMs ?? 2000,
      userCooldownMs: fileConfig.bot?.userCooldownMs ?? 5000,
      maxRequestsPerWindow: fileConfig.bot?.maxRequestsPerWindow ?? 6,
      windowMs: fileConfig.bot?.windowMs ?? 60000,
      shortTermMemorySize: fileConfig.bot?.shortTermMemorySize ?? 20,
      longTermMemoryInterval: fileConfig.bot?.longTermMemoryInterval ?? 50,
      systemPromptFile: process.env.SYSTEM_PROMPT_FILE ?? fileConfig.bot?.systemPromptFile ?? 'friendly',
    },
  };
}

export function getTwitchClientId(): string {
  return process.env.TWITCH_CLIENT_ID ?? DEFAULT_TWITCH_CLIENT_ID;
}
