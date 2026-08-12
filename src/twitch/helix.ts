import { getTwitchClientId } from '../config';
import { TokenData, isTokenExpired } from '../auth/tokens';
import { refreshToken } from '../auth/deviceCode';
import { validateToken } from '../auth/validate';

interface HelixResponse<T> {
  data?: T;
  error?: string;
  status?: number;
  message?: string;
}

interface ChatMessageRequest {
  broadcaster_id: string;
  sender_id: string;
  message: string;
}

export class HelixClient {
  private broadcasterTokens: TokenData | null = null;
  private botTokens: TokenData | null = null;
  private refreshLock = false;

  constructor(broadcasterTokens: TokenData, botTokens?: TokenData) {
    this.broadcasterTokens = broadcasterTokens;
    this.botTokens = botTokens ?? broadcasterTokens;
  }

  private async ensureValidToken(accountType: 'broadcaster' | 'bot'): Promise<string> {
    const tokens = accountType === 'bot' ? this.botTokens : this.broadcasterTokens;
    if (!tokens) {
      throw new Error(`${accountType} tokens not set`);
    }

    if (isTokenExpired(tokens)) {
      await this.refreshToken(accountType);
    }

    return tokens.access_token;
  }

  private async refreshToken(accountType: 'broadcaster' | 'bot'): Promise<void> {
    if (this.refreshLock) {
      throw new Error('Token refresh already in progress');
    }

    this.refreshLock = true;
    try {
      const tokens = accountType === 'bot' ? this.botTokens : this.broadcasterTokens;
      if (!tokens) {
        throw new Error(`${accountType} tokens not available for refresh`);
      }

      const refreshed = await refreshToken(tokens.refresh_token);
      if (!refreshed) {
        throw new Error(`Token refresh failed for ${accountType}`);
      }

      // Validate and get user info
      const validation = await validateToken(refreshed.access_token, accountType);
      if (!validation) {
        throw new Error(`Token validation failed after refresh for ${accountType}`);
      }

      const updatedTokens = {
        ...refreshed,
        user_id: validation.user_id,
        user_login: validation.login,
      };

      if (accountType === 'bot') {
        this.botTokens = updatedTokens;
      } else {
        this.broadcasterTokens = updatedTokens;
      }
    } finally {
      this.refreshLock = false;
    }
  }

  async sendMessage(broadcasterId: string, senderId: string, message: string): Promise<boolean> {
    const token = await this.ensureValidToken('bot');
    const clientId = getTwitchClientId();

    try {
      const response = await fetch('https://api.twitch.tv/helix/chat/messages', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Client-Id': clientId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          broadcaster_id: broadcasterId,
          sender_id: senderId,
          message,
        }),
      });

      if (response.status === 401) {
        await this.refreshToken('bot');
        return this.sendMessage(broadcasterId, senderId, message);
      }

      if (!response.ok) {
        const text = await response.text();
        console.error(`[ERROR] Helix send message failed: HTTP ${response.status} - ${text}`);
        return false;
      }

      const data = await response.json() as HelixResponse<{ message_id: string; is_sent: boolean }[]>;
      return data.data?.[0]?.is_sent ?? false;
    } catch (error) {
      console.error(`[ERROR] Helix send message request failed: ${error}`);
      return false;
    }
  }

  async subscribeEventSub(
    eventType: string,
    eventVersion: string,
    condition: Record<string, string>,
    sessionId: string
  ): Promise<boolean> {
    const token = await this.ensureValidToken('bot');
    const clientId = getTwitchClientId();

    try {
      const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Client-Id': clientId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: eventType,
          version: eventVersion,
          condition,
          transport: {
            method: 'websocket',
            session_id: sessionId,
          },
        }),
      });

      if (response.status === 401) {
        await this.refreshToken('bot');
        return this.subscribeEventSub(eventType, eventVersion, condition, sessionId);
      }

      if (!response.ok) {
        const text = await response.text();
        console.error(`[ERROR] EventSub subscription failed: HTTP ${response.status} - ${text}`);
        return false;
      }

      return true;
    } catch (error) {
      console.error(`[ERROR] EventSub subscription request failed: ${error}`);
      return false;
    }
  }

  getBotUserId(): string {
    return this.botTokens?.user_id ?? '';
  }
}
