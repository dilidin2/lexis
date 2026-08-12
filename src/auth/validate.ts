import { getTwitchClientId } from '../config';
import { TokenData } from './tokens';

export interface TokenValidationResult {
  valid: boolean;
  user_id: string;
  login: string;
  scopes: string[];
  expires_at: number;
}

const REQUIRED_BROADCASTER_SCOPES = ['user:read:chat', 'user:write:chat'];
const REQUIRED_BOT_SCOPES = ['user:read:chat', 'user:write:chat', 'user:bot'];
const CRITICAL_SCOPES = ['user:read:chat'];

export async function validateToken(access_token: string, accountType: 'broadcaster' | 'bot'): Promise<TokenValidationResult | null> {
  const clientId = getTwitchClientId();
  const requiredScopes = accountType === 'bot' ? REQUIRED_BOT_SCOPES : REQUIRED_BROADCASTER_SCOPES;

  try {
    const response = await fetch('https://id.twitch.tv/oauth2/validate', {
      method: 'GET',
      headers: {
        'Authorization': `OAuth ${access_token}`,
      },
    });

    if (!response.ok) {
      console.error(`[ERROR] Token validation failed for ${accountType}: HTTP ${response.status}`);
      return null;
    }

    const data = await response.json() as Record<string, unknown>;
    const client_id = data.client_id as string;
    const user_id = data.user_id as string;
    const login = data.login as string;
    const scopes = (data.scopes as string[] | undefined) ?? [];
    const expires_in = data.expires_in as number;

    if (client_id !== clientId) {
      console.error(`[ERROR] Token belongs to different client ID`);
      return null;
    }

    const expires_at = Date.now() + (expires_in * 1000);

    // Check for critical missing scopes
    const missingCritical = CRITICAL_SCOPES.filter(s => !scopes.includes(s));
    if (missingCritical.length > 0) {
      console.error(`[ERROR] ${accountType} token missing critical scopes: ${missingCritical.join(', ')}`);
      return null;
    }

    // Check for missing non-critical scopes (degraded mode)
    const missingScopes = requiredScopes.filter(s => !scopes.includes(s));
    if (missingScopes.length > 0) {
      console.warn(`[WARN] ${accountType} token missing scopes (degraded mode): ${missingScopes.join(', ')}`);
    }

    return {
      valid: true,
      user_id,
      login,
      scopes,
      expires_at,
    };
  } catch (error) {
    console.error(`[ERROR] Token validation request failed for ${accountType}: ${error}`);
    return null;
  }
}
