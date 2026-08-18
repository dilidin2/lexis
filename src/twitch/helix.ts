import { getTwitchClientId } from '../config';
import { TokenData, isTokenExpired, saveTokens } from '../auth/tokens';
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
  private refreshInFlight: { broadcaster: Promise<void> | null; bot: Promise<void> | null } = {
    broadcaster: null,
    bot: null,
  };

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
    // If a refresh is already running, wait for it instead of throwing (two
    // concurrent callers must never refresh the same refresh token).
    if (this.refreshInFlight[accountType]) {
      await this.refreshInFlight[accountType];
      return;
    }

    const refreshPromise = (async (): Promise<void> => {
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

      const updatedTokens: TokenData = {
        ...refreshed,
        user_id: validation.user_id,
        user_login: validation.login,
      };

      if (accountType === 'bot') {
        this.botTokens = updatedTokens;
      } else {
        this.broadcasterTokens = updatedTokens;
      }

      // Twitch rotates the refresh token on every refresh; the old one is now
      // invalid. Persist the new pair immediately so other instances and
      // future process restarts don't try to reuse it.
      saveTokens(accountType, updatedTokens);
    })();

    this.refreshInFlight[accountType] = refreshPromise;
    try {
      await refreshPromise;
    } finally {
      this.refreshInFlight[accountType] = null;
    }
  }

  private async getValidToken(accountType: 'broadcaster' | 'bot'): Promise<string | null> {
    try {
      return await this.ensureValidToken(accountType);
    } catch (error) {
      console.error(`[ERROR] Could not obtain a valid ${accountType} token: ${error}`);
      return null;
    }
  }

  async sendMessage(broadcasterId: string, senderId: string, message: string): Promise<boolean> {
    const clientId = getTwitchClientId();

    // Two attempts: the first with the current token, a second after a
    // forced refresh if Twitch answers 401.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const token = await this.getValidToken('bot');
      if (!token) {
        return false;
      }

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
          if (attempt >= 2) {
            console.error('[ERROR] Helix send message failed: token still invalid after refresh');
            return false;
          }
          console.warn('[WARN] Helix send message returned 401, refreshing token and retrying...');
          try {
            await this.refreshToken('bot');
          } catch (error) {
            console.error(`[ERROR] Token refresh after 401 failed: ${error}`);
            return false;
          }
          continue;
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

    return false;
  }

  async subscribeEventSub(
    eventType: string,
    eventVersion: string,
    condition: Record<string, string>,
    sessionId: string
  ): Promise<boolean> {
    const clientId = getTwitchClientId();

    for (let attempt = 1; attempt <= 2; attempt++) {
      const token = await this.getValidToken('bot');
      if (!token) {
        return false;
      }

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
          if (attempt >= 2) {
            console.error('[ERROR] EventSub subscription failed: token still invalid after refresh');
            return false;
          }
          console.warn('[WARN] EventSub subscription returned 401, refreshing token and retrying...');
          try {
            await this.refreshToken('bot');
          } catch (error) {
            console.error(`[ERROR] Token refresh after 401 failed: ${error}`);
            return false;
          }
          continue;
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

    return false;
  }

  getBotUserId(): string {
    return this.botTokens?.user_id ?? '';
  }
}
