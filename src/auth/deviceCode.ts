import { getTwitchClientId } from '../config';
import { TokenData, saveTokens, deleteTokens } from './tokens';
import { validateToken } from './validate';

interface DeviceCodeResponse {
  device_code: string;
  expires_in: number;
  interval: number;
  user_code: string;
  verification_uri: string;
}

interface TokenPollResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string[];
  token_type?: string;
  status?: number;
  message?: string;
}

const SCOPES_BROADCASTER = 'user:read:chat user:write:chat';
const SCOPES_BOT = 'user:read:chat user:write:chat user:bot';

function printAuthBox(title: string, verificationUri: string, userCode: string): void {
  const box = `
╔══════════════════════════════════════════════════════════╗
║  Lexis — ${title.padEnd(40)}║
║                                                          ║
║  Please authorize the account:                            ║
║                                                          ║
║  1. Open this URL in your browser:                        ║
║     ${verificationUri.padEnd(44)}║
║                                                          ║
║  2. Enter this code:                                      ║
║     ${userCode.padEnd(46)}║
║                                                          ║
║  3. Authorize Lexis when prompted.                        ║
║                                                          ║
║  Waiting for authorization...                             ║
╚══════════════════════════════════════════════════════════╝`;
  console.log(box);
}

async function requestDeviceCode(scopes: string): Promise<DeviceCodeResponse> {
  const clientId = getTwitchClientId();
  const response = await fetch('https://id.twitch.tv/oauth2/device', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: clientId,
      scopes,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Device code request failed: HTTP ${response.status} - ${text}`);
  }

  return response.json() as Promise<DeviceCodeResponse>;
}

async function pollForToken(clientId: string, deviceCode: string, scopes: string, interval: number): Promise<TokenPollResponse> {
  let currentInterval = interval * 1000;

  while (true) {
    await new Promise(resolve => setTimeout(resolve, currentInterval));

    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        scopes,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const data = await response.json() as Record<string, unknown>;
    const status = data.status as number | undefined;
    const message = data.message as string | undefined;
    const access_token = data.access_token as string | undefined;
    const refresh_token = data.refresh_token as string | undefined;
    const expires_in = data.expires_in as number | undefined;
    const scope = data.scope as string[] | undefined;

    if (access_token) {
      return { access_token, refresh_token, expires_in, scope, token_type: 'bearer' };
    }

    if (message === 'authorization_pending') {
      continue;
    }

    if (message === 'slow_down') {
      currentInterval *= 2;
      continue;
    }

    if (message === 'access_denied') {
      throw new Error('Authorization denied by user');
    }

    if (message === 'expired_token') {
      throw new Error('Device code expired. Please try again.');
    }

    throw new Error(`Unknown polling response: ${JSON.stringify(data)}`);
  }
}

export async function refreshToken(refreshToken: string): Promise<TokenData | null> {
  const clientId = getTwitchClientId();

  try {
    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });

    if (!response.ok) {
      console.error(`[ERROR] Token refresh failed: HTTP ${response.status}`);
      return null;
    }

    const data = await response.json() as Record<string, unknown>;
    return {
      access_token: data.access_token as string,
      refresh_token: data.refresh_token as string,
      user_id: '',
      user_login: '',
      expires_at: Date.now() + ((data.expires_in as number) * 1000),
    };
  } catch (error) {
    console.error(`[ERROR] Token refresh request failed: ${error}`);
    return null;
  }
}

export async function authenticate(accountType: 'broadcaster' | 'bot'): Promise<TokenData> {
  const scopes = accountType === 'bot' ? SCOPES_BOT : SCOPES_BROADCASTER;
  const clientId = getTwitchClientId();

  try {
    const deviceCode = await requestDeviceCode(scopes);
    printAuthBox(
      accountType === 'bot' ? 'Bot Account Authentication' : 'Broadcaster Authentication',
      deviceCode.verification_uri,
      deviceCode.user_code
    );

    const tokenResponse = await pollForToken(clientId, deviceCode.device_code, scopes, deviceCode.interval);

    if (!tokenResponse.access_token || !tokenResponse.refresh_token) {
      throw new Error('Token response missing required fields');
    }

    const validation = await validateToken(tokenResponse.access_token, accountType);
    if (!validation) {
      throw new Error('Token validation failed after authentication');
    }

    const tokenData: TokenData = {
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token,
      user_id: validation.user_id,
      user_login: validation.login,
      expires_at: validation.expires_at,
    };

    saveTokens(accountType, tokenData);
    return tokenData;
  } catch (error) {
    deleteTokens(accountType);
    throw error;
  }
}
