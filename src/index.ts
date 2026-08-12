import { loadConfig, getTwitchClientId } from './config';
import { loadTokens, saveTokens, isTokenExpired, TokenData } from './auth/tokens';
import { validateToken } from './auth/validate';
import { authenticate, refreshToken } from './auth/deviceCode';
import { EventSubWebSocket } from './twitch/websocket';
import { HelixClient } from './twitch/helix';
import { LLMClient } from './llm/client';
import { ShortTermMemory } from './memory/shortTerm';
import { LongTermMemory } from './memory/longTerm';
import { CommandHandler } from './handlers/command';

interface ParsedArgs {
  bot: boolean;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  return {
    bot: args.includes('--bot'),
  };
}

async function ensureBroadcasterAuth(): Promise<TokenData> {
  console.log('[INFO] Checking broadcaster authentication...');

  let tokens = loadTokens('broadcaster');

  if (tokens && !isTokenExpired(tokens)) {
    const validation = await validateToken(tokens.access_token, 'broadcaster');
    if (validation) {
      console.log(`[INFO] Broadcaster authenticated as ${tokens.user_login}`);
      return tokens;
    }
    console.log('[INFO] Broadcaster token invalid, attempting refresh...');
  }

  // Try refresh if we have tokens
  if (tokens) {
    const refreshed = await refreshToken(tokens.refresh_token);
    if (refreshed) {
      const validation = await validateToken(refreshed.access_token, 'broadcaster');
      if (validation) {
        const updatedTokens: TokenData = {
          ...refreshed,
          user_id: validation.user_id,
          user_login: validation.login,
        };
        saveTokens('broadcaster', updatedTokens);
        console.log(`[INFO] Broadcaster token refreshed as ${updatedTokens.user_login}`);
        return updatedTokens;
      }
    }
  }

  // Device Code Flow
  console.log('[INFO] Starting broadcaster authentication via Device Code Flow...');
  try {
    const newTokens = await authenticate('broadcaster');
    console.log(`[INFO] Broadcaster authenticated as ${newTokens.user_login}`);
    return newTokens;
  } catch (error) {
    console.error(`[ERROR] Broadcaster authentication failed: ${error}`);
    process.exit(1);
  }
}

async function ensureBotAuth(): Promise<TokenData> {
  console.log('[INFO] Checking bot account authentication...');

  let tokens = loadTokens('bot');

  if (tokens && !isTokenExpired(tokens)) {
    const validation = await validateToken(tokens.access_token, 'bot');
    if (validation) {
      console.log(`[INFO] Bot account authenticated as ${tokens.user_login}`);
      return tokens;
    }
    console.log('[INFO] Bot token invalid, attempting refresh...');
  }

  // Try refresh if we have tokens
  if (tokens) {
    const refreshed = await refreshToken(tokens.refresh_token);
    if (refreshed) {
      const validation = await validateToken(refreshed.access_token, 'bot');
      if (validation) {
        const updatedTokens: TokenData = {
          ...refreshed,
          user_id: validation.user_id,
          user_login: validation.login,
        };
        saveTokens('bot', updatedTokens);
        console.log(`[INFO] Bot token refreshed as ${updatedTokens.user_login}`);
        return updatedTokens;
      }
    }
  }

  // Device Code Flow
  console.log('[INFO] Starting bot account authentication via Device Code Flow...');
  try {
    const newTokens = await authenticate('bot');
    console.log(`[INFO] Bot account authenticated as ${newTokens.user_login}`);
    return newTokens;
  } catch (error) {
    console.error(`[ERROR] Bot account authentication failed: ${error}`);
    process.exit(1);
  }
}

function setupGracefulShutdown(commandHandler: CommandHandler, websocket: EventSubWebSocket): void {
  const shutdown = async (signal: string) => {
    console.log(`\n[INFO] Received ${signal}, shutting down gracefully...`);
    commandHandler.flush();
    websocket.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║                    LEXIS BOT                            ║');
  console.log('║         AI-Powered Twitch Chat Companion                ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Parse CLI arguments
  const args = parseArgs();
  console.log(`[INFO] Bot mode: ${args.bot ? 'separate bot account' : 'broadcaster account'}`);

  // Load config
  let config = loadConfig();
  console.log(`[INFO] Config loaded: model=${config.llm.model}, prompt=${config.bot.systemPromptFile}`);

  // Authenticate broadcaster
  const broadcasterTokens = await ensureBroadcasterAuth();

  // Use broadcaster user ID as channel user ID (deduced from token)
  config.twitch.channelUserId = broadcasterTokens.user_id;
  console.log(`[INFO] Channel user ID: ${config.twitch.channelUserId}`);

  // Authenticate bot account or use broadcaster
  let botTokens: TokenData;
  if (args.bot) {
    botTokens = await ensureBotAuth();
  } else {
    botTokens = broadcasterTokens;
    console.log('[INFO] Using broadcaster account for bot operations');
  }

  // Initialize components
  const llm = new LLMClient(config.llm);
  const shortTermMemory = new ShortTermMemory(config.bot);
  const longTermMemory = new LongTermMemory(llm);
  const helix = new HelixClient(broadcasterTokens, botTokens);
  const commandHandler = new CommandHandler(config, llm, shortTermMemory, longTermMemory, helix);

  // Setup EventSub WebSocket
  const websocket = new EventSubWebSocket(broadcasterTokens, botTokens);
  websocket.setOnMessageCallback((event) => {
    commandHandler.handleEvent(event);
  });

  // Setup graceful shutdown
  setupGracefulShutdown(commandHandler, websocket);

  // Connect
  await websocket.connect();

  console.log('\n[INFO] Lexis bot is running!');
  console.log(`[INFO] Channel: ${config.twitch.channelUserId}`);
  console.log(`[INFO] Bot account: ${botTokens.user_login}`);
  console.log(`[INFO] Command: ${config.bot.commandPrefix}`);
}

main().catch((error) => {
  console.error(`[FATAL] ${error}`);
  process.exit(1);
});
