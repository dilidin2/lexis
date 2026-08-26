import * as fs from 'fs';
import * as path from 'path';

const PROMPTS_DIR = path.join(__dirname, '..', '..', 'prompts');

export function loadSystemPrompt(promptName: string): string {
  const promptPath = path.join(PROMPTS_DIR, `${promptName}.txt`);

  try {
    if (!fs.existsSync(promptPath)) {
      console.warn(`[WARN] System prompt file not found: ${promptPath}, falling back to 'friendly'`);
      return loadSystemPrompt('friendly');
    }

    const content = fs.readFileSync(promptPath, 'utf-8').trim();
    if (!content) {
      console.warn(`[WARN] System prompt file is empty: ${promptPath}, falling back to 'friendly'`);
      return loadSystemPrompt('friendly');
    }

    return content;
  } catch (error) {
    console.error(`[ERROR] Failed to load system prompt: ${error}`);
    return loadSystemPrompt('friendly');
  }
}

export function buildFullSystemPrompt(
  personalityPrompt: string,
  longTermMemory: string,
  maxResponseLength: number
): string {
  const parts: string[] = [personalityPrompt];

  if (longTermMemory.trim()) {
    parts.push('');
    parts.push('=== LONG-TERM MEMORY ===');
    parts.push(longTermMemory.trim());
    parts.push('=== END LONG-TERM MEMORY ===');
  }

  parts.push('');
  parts.push('=== CHAT CONTEXT RULES ===');
  parts.push('You are Lexis, responding live in a Twitch chat with many different users.');
  parts.push('In the conversation history, each message is prefixed like "username: message".');
  parts.push('This prefix is metadata showing who sent the message — it is NOT part of what');
  parts.push('they said, and you must never write your own replies with a "Lexis:" prefix.');
  parts.push('Different messages may come from different users; do not assume they are the');
  parts.push('same person, and never speak as if you were one of the chat users. Never write');
  parts.push('messages on their behalf or imitate their voice.');
  parts.push('');
  parts.push('Always start your reply by addressing the current user as @username (using');
  parts.push('their exact username, no "the user" or other placeholder).');
  parts.push('Keep your response under ' + maxResponseLength + ' characters.');
  parts.push('Do not use markdown formatting in your response.');
  parts.push('=== END CHAT CONTEXT RULES ===');

  return parts.join('\n');
}
