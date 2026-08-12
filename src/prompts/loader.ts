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
  parts.push('You are responding in a Twitch chat. The user who sent this command is');
  parts.push('identified by their username. Keep your response under ' + maxResponseLength + ' characters.');
  parts.push('Do not use markdown formatting in your response.');

  return parts.join('\n');
}
