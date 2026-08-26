// ANSI color codes
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const ITALIC = '\x1b[3m';

// Foreground colors
const BLACK = '\x1b[30m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';
const GRAY = '\x1b[90m';

// Bright colors
const BRIGHT_RED = '\x1b[91m';
const BRIGHT_GREEN = '\x1b[92m';
const BRIGHT_YELLOW = '\x1b[93m';
const BRIGHT_BLUE = '\x1b[94m';
const BRIGHT_MAGENTA = '\x1b[95m';
const BRIGHT_CYAN = '\x1b[96m';

// Background colors
const BG_RED = '\x1b[41m';
const BG_GREEN = '\x1b[42m';
const BG_YELLOW = '\x1b[43m';
const BG_BLUE = '\x1b[44m';
const BG_MAGENTA = '\x1b[45m';
const BG_CYAN = '\x1b[46m';

function timestamp(): string {
  const now = new Date();
  return now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function truncate(str: string, maxLen: number = 100): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + '...';
}

function divider(char: string = '─', width: number = 60): string {
  return char.repeat(width);
}

function boxTop(text: string, width: number = 60): string {
  const padding = 3;
  const availableWidth = width - padding * 2;
  const paddedText = text.padEnd(availableWidth).substring(0, availableWidth);
  return `╔${'═'.repeat(width - 2)}╗\n║ ${BOLD}${paddedText}${RESET} ${' '.repeat(Math.max(0, availableWidth - text.length))}║`;
}

function boxBottom(width: number = 60): string {
  return `╚${'═'.repeat(width - 2)}╝`;
}

function bar(char: string, value: number, max: number, width: number = 20, color: string = GREEN): string {
  const filled = Math.round((value / max) * width);
  const empty = width - filled;
  return `${color}${char.repeat(Math.max(0, filled))}${RESET}${DIM}${char.repeat(Math.max(0, empty))}${RESET}`;
}

class Logger {
  private prefix: string;

  constructor(prefix: string = 'LEXIS') {
    this.prefix = prefix;
  }

  private tag(label: string, bgColor: string, fgColor: string = WHITE): string {
    return `${bgColor}${fgColor}${BOLD} ${label} ${RESET}`;
  }

  private header(color: string, icon: string, label: string): string {
    return `${color}${BOLD}${icon} ${label}${RESET}`;
  }

  // Standard log levels
  info(message: string, ...args: any[]): void {
    console.log(`[${DIM}${timestamp()}${RESET}] ${this.tag('INFO', BG_BLUE, WHITE)} ${message}`, ...args);
  }

  warn(message: string, ...args: any[]): void {
    console.warn(`[${DIM}${timestamp()}${RESET}] ${this.tag('WARN', BG_YELLOW, BLACK)} ${YELLOW}${message}${RESET}`, ...args);
  }

  error(message: string, ...args: any[]): void {
    console.error(`[${DIM}${timestamp()}${RESET}] ${this.tag('ERR', BG_RED, WHITE)} ${RED}${message}${RESET}`, ...args);
  }

  success(message: string, ...args: any[]): void {
    console.log(`[${DIM}${timestamp()}${RESET}] ${this.tag('OK', BG_GREEN, WHITE)} ${GREEN}${message}${RESET}`, ...args);
  }

  debug(message: string, ...args: any[]): void {
    console.log(`[${DIM}${timestamp()}${RESET}] ${DIM}DEBUG ${message}${RESET}`, ...args);
  }

  // Chat message received
  chatMessage(username: string, message: string, messageId: string): void {
    const userTag = `${CYAN}${BOLD}@${username}${RESET}`;
    const msgPreview = truncate(message, 80);
    const idPreview = messageId.substring(0, 8);
    console.log(
      `[${DIM}${timestamp()}${RESET}] ${this.tag('CHAT', BG_MAGENTA, WHITE)} ${BRIGHT_CYAN}💬${RESET} ${userTag} → ${DIM}"${msgPreview}"${RESET} ${DIM}[${idPreview}]${RESET}`
    );
  }

  // Message rejected
  messageRejected(username: string, reason: string, details?: string): void {
    const userTag = `${CYAN}${BOLD}@${username}${RESET}`;
    console.log(
      `[${DIM}${timestamp()}${RESET}] ${this.tag('REJECT', BG_RED, WHITE)} ${BRIGHT_RED}✗${RESET} ${userTag} ${RED}${reason}${RESET}${details ? ` ${DIM}${details}${RESET}` : ''}`
    );
  }

  // LLM response sent
  llmResponse(username: string, response: string, tokens?: number): void {
    const userTag = `${CYAN}${BOLD}→ @${username}${RESET}`;
    const respPreview = truncate(response, 80);
    const tokenInfo = tokens ? ` ${DIM}(${tokens} tokens)${RESET}` : '';
    console.log(
      `[${DIM}${timestamp()}${RESET}] ${this.tag('LLM', BG_CYAN, WHITE)} ${BRIGHT_GREEN}✓${RESET} ${userTag} ${DIM}"${respPreview}"${RESET}${tokenInfo}`
    );
  }

  // Memory consolidation start
  memoryConsolidationStart(entriesCount: number, counter: number, interval: number): void {
    console.log(`\n${boxTop('MEMORY CONSOLIDATION', 60)}`);
    console.log(`║ ${DIM}Started at ${timestamp()}${RESET}`);
    console.log(`║ ${CYAN}Short-term entries:${RESET} ${BOLD}${entriesCount}${RESET}`);
    console.log(`║ ${MAGENTA}Consolidation counter:${RESET} ${BOLD}${counter}/${interval}${RESET} ${bar('█', counter, interval, 15, BRIGHT_YELLOW)}`);
    console.log(`${boxBottom(60)}\n`);
  }

  // Memory consolidation end
  memoryConsolidationEnd(saved: boolean, entriesSaved: number, durationMs: number, fileStats?: MemoryFileStats): void {
    const verb = saved ? BRIGHT_GREEN : DIM;
    const icon = saved ? '💾' : '📭';
    const action = saved ? 'Entries saved' : 'Nothing to save';

    console.log(`\n${boxTop('MEMORY CONSOLIDATION COMPLETE', 60)}`);
    console.log(`║ ${DIM}Completed at ${timestamp()}${RESET}`);
    console.log(`║ ${verb}${icon} ${action}${RESET}${saved ? `: ${BOLD}${entriesSaved}${RESET} new entries` : ''}`);
    console.log(`║ ${DIM}Duration:${RESET} ${BOLD}${(durationMs / 1000).toFixed(1)}s${RESET}`);
    if (fileStats) {
      console.log(`║ ${DIM}MEMORY.md stats:${RESET}`);
      console.log(`║   ${BLUE}Size:${RESET} ${fileStats.sizeKB.toFixed(1)} KB | ${BLUE}Lines:${RESET} ${fileStats.lineCount} | ${BLUE}Sections:${RESET} ${fileStats.sectionCount}`);
    }
    console.log(`${boxBottom(60)}\n`);
  }

  // Memory file loaded
  memoryFileLoaded(sizeKB: number, lineCount: number): void {
    console.log(
      `[${DIM}${timestamp()}${RESET}] ${this.tag('MEM', BG_GREEN, WHITE)} ${DIM}MEMORY.md loaded: ${sizeKB.toFixed(1)} KB, ${lineCount} lines${RESET}`
    );
  }

  // Context approaching limit
  contextWarning(currentTokens: number, maxTokens: number, percentage: number): void {
    const color = percentage > 90 ? BRIGHT_RED : percentage > 75 ? BRIGHT_YELLOW : YELLOW;
    console.log(
      `[${DIM}${timestamp()}${RESET}] ${this.tag('CTX', BG_YELLOW, BLACK)} ${color}⚠ Context: ${currentTokens.toLocaleString()}/${maxTokens.toLocaleString()} tokens (${percentage.toFixed(0)}%) ${bar('░', percentage, 100, 20, color)}${RESET}`
    );
  }

  // Response truncated
  responseTruncated(originalLength: number, truncatedLength: number, reason: string): void {
    console.log(
      `[${DIM}${timestamp()}${RESET}] ${this.tag('TRUNC', BG_YELLOW, BLACK)} ${YELLOW}✂ Response truncated: ${originalLength} → ${truncatedLength} chars (${reason})${RESET}`
    );
  }

  // Global LLM rate limit reached, request dropped
  rateLimited(username: string, used: number, max: number, windowMs: number): void {
    const userTag = `${CYAN}${BOLD}@${username}${RESET}`;
    const windowSec = (windowMs / 1000).toFixed(0);
    console.log(
      `[${DIM}${timestamp()}${RESET}] ${this.tag('RATE', BG_RED, WHITE)} ${BRIGHT_RED}🚦${RESET} ${userTag} ${RED}global LLM limit reached${RESET} ${DIM}(${used}/${max} requests in ${windowSec}s, dropped)${RESET}`
    );
  }

  // Cooldown hit
  cooldownHit(username: string, remainingMs: number): void {
    const remainingSec = (remainingMs / 1000).toFixed(1);
    console.log(
      `[${DIM}${timestamp()}${RESET}] ${this.tag('COOL', BG_YELLOW, BLACK)} ${YELLOW}⏱ @${username} on cooldown (${remainingSec}s remaining)${RESET}`
    );
  }

  // Separator line
  separator(char: string = '·', width: number = 40): void {
    console.log(`[${DIM}${timestamp()}${RESET}] ${DIM}${char.repeat(width)}${RESET}`);
  }
}

export interface MemoryFileStats {
  sizeKB: number;
  lineCount: number;
  sectionCount: number;
}

// Default logger instance
export const logger = new Logger();

export default logger;
