import * as fs from 'fs';
import * as path from 'path';

export interface TokenData {
  access_token: string;
  refresh_token: string;
  user_id: string;
  user_login: string;
  expires_at: number;
}

function getTokenFilePath(accountType: 'broadcaster' | 'bot'): string {
  return path.join(__dirname, '..', '..', `${accountType}_tokens.json`);
}

export function loadTokens(accountType: 'broadcaster' | 'bot'): TokenData | null {
  const filePath = getTokenFilePath(accountType);
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`[ERROR] Failed to load ${accountType} tokens: ${error}`);
    return null;
  }
}

export function saveTokens(accountType: 'broadcaster' | 'bot', tokens: TokenData): void {
  const filePath = getTokenFilePath(accountType);
  try {
    fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2), 'utf-8');
    console.log(`[INFO] ${accountType} tokens saved to ${filePath}`);
  } catch (error) {
    console.error(`[ERROR] Failed to save ${accountType} tokens: ${error}`);
  }
}

export function deleteTokens(accountType: 'broadcaster' | 'bot'): void {
  const filePath = getTokenFilePath(accountType);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[INFO] ${accountType} tokens deleted`);
    }
  } catch (error) {
    console.error(`[ERROR] Failed to delete ${accountType} tokens: ${error}`);
  }
}

export function isTokenExpired(tokens: TokenData): boolean {
  return Date.now() >= tokens.expires_at;
}

export function isTokenNearlyExpired(tokens: TokenData, thresholdMs: number = 300000): boolean {
  return Date.now() >= (tokens.expires_at - thresholdMs);
}
