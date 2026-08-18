import WebSocket from 'ws';
import { TokenData } from '../auth/tokens';
import { HelixClient } from './helix';

export interface ChatMessageEvent {
  broadcaster_user_id: string;
  broadcaster_user_login: string;
  chatter_user_id: string;
  chatter_user_login: string;
  chatter_user_name: string;
  message: {
    text: string;
  };
  message_id: string;
}

export interface ChatMessagePayload {
  subscription?: {
    type: string;
  };
  event: ChatMessageEvent;
}

export type OnMessageCallback = (event: ChatMessageEvent) => void;

export class EventSubWebSocket {
  private ws: WebSocket | null = null;
  private helix: HelixClient;
  private broadcasterUserId: string;
  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private keepaliveTimeout: NodeJS.Timeout | null = null;
  private reconnectUrl: string | null = null;
  private onMessageCallback: OnMessageCallback | null = null;
  private isConnecting = false;
  private isConnectingBot = false;

  // A single shared HelixClient must be used across the whole process:
  // Twitch rotates refresh tokens on every refresh, and two independent
  // instances would each refresh the same refresh token, invalidating the
  // other one.
  constructor(broadcasterTokens: TokenData, helix: HelixClient) {
    this.helix = helix;
    this.broadcasterUserId = broadcasterTokens.user_id;
  }

  setOnMessageCallback(callback: OnMessageCallback): void {
    this.onMessageCallback = callback;
  }

  async connect(): Promise<void> {
    if (this.isConnecting || this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.isConnecting = true;
    console.log('[INFO] Connecting to EventSub WebSocket...');

    try {
      const ws = new WebSocket('wss://eventsub.wss.twitch.tv/ws');
      this.ws = ws;

      ws.on('open', () => {
        console.log('[INFO] EventSub WebSocket connected');
        this.reconnectAttempts = 0;
      });

      ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

      ws.on('close', (code, reason) => {
        console.log(`[INFO] EventSub WebSocket disconnected: ${code} ${reason?.toString()}`);
        this.scheduleReconnect();
      });

      ws.on('error', (error) => {
        console.error(`[ERROR] EventSub WebSocket error: ${error.message}`);
      });

    } catch (error) {
      console.error(`[ERROR] Failed to connect EventSub WebSocket: ${error}`);
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  private handleMessage(raw: string): void {
    try {
      const message = JSON.parse(raw);
      const messageType = message.metadata?.message_type;

      switch (messageType) {
        case 'session_welcome':
          this.handleSessionWelcome(message);
          break;
        case 'session_keepalive':
          this.handleKeepalive();
          break;
        case 'session_reconnect':
          this.handleReconnect(message);
          break;
        case 'notification':
          this.handleNotification(message);
          break;
        default:
          console.log(`[INFO] Unknown EventSub message type: ${messageType}`);
      }
    } catch (error) {
      console.error(`[ERROR] Failed to parse EventSub message: ${error}`);
    }
  }

  private async handleSessionWelcome(message: any): Promise<void> {
    const sessionId = message.payload?.session?.id;
    if (!sessionId) {
      console.error('[ERROR] session_welcome missing session ID');
      return;
    }

    console.log(`[INFO] EventSub session welcome, session ID: ${sessionId}`);

    const botUserId = this.helix.getBotUserId();
    const subscribed = await this.helix.subscribeEventSub(
      'channel.chat.message',
      '1',
      {
        broadcaster_user_id: this.broadcasterUserId,
        user_id: botUserId,
      },
      sessionId
    );

    if (!subscribed) {
      console.error('[ERROR] Failed to subscribe to channel.chat.message');
    } else {
      console.log('[INFO] Subscribed to channel.chat.message');
    }

    this.isConnecting = false;
    this.resetKeepaliveTimeout();
  }

  private handleKeepalive(): void {
    this.resetKeepaliveTimeout();
  }

  private handleReconnect(message: any): void {
    const reconnectUrl = message.payload?.session?.reconnect_url;
    if (reconnectUrl) {
      console.log('[INFO] EventSub requesting reconnect');
      this.reconnectUrl = reconnectUrl;
      this.disconnect();
      this.connectWithReconnectUrl();
    }
  }

  private handleNotification(message: any): void {
    if (!this.onMessageCallback) return;

    const subscriptionType = message.metadata?.subscription_type;
    const payload = message.payload as ChatMessagePayload | undefined;
    if (!payload) {
      console.warn('[WARN] Notification missing payload');
      return;
    }

    // Validate subscription type
    if (subscriptionType !== 'channel.chat.message') {
      return;
    }

    const event = payload.event;

    // Validate required fields
    if (!event.chatter_user_login || !event.message?.text || !event.message_id) {
      console.warn('[WARN] Malformed chat message event, skipping');
      return;
    }

    // Filter out bot's own messages
    const botUserId = this.helix.getBotUserId();
    if (event.chatter_user_id === botUserId) {
      return;
    }

    this.onMessageCallback(event);
  }

  private resetKeepaliveTimeout(): void {
    if (this.keepaliveTimeout) {
      clearTimeout(this.keepaliveTimeout);
    }
    // 30 seconds without keepalive means connection is dead
    this.keepaliveTimeout = setTimeout(() => {
      console.log('[WARN] EventSub keepalive timeout, reconnecting');
      this.disconnect();
      this.scheduleReconnect();
    }, 30000);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);

    console.log(`[INFO] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimeout = setTimeout(() => {
      if (this.reconnectUrl) {
        this.connectWithReconnectUrl();
      } else {
        this.connect();
      }
    }, delay);
  }

  private connectWithReconnectUrl(): void {
    if (!this.reconnectUrl || this.isConnecting) return;

    this.isConnecting = true;
    console.log(`[INFO] Reconnecting to EventSub using reconnect URL...`);

    try {
      const ws = new WebSocket(this.reconnectUrl);
      this.ws = ws;
      this.reconnectUrl = null;

      ws.on('open', () => {
        console.log('[INFO] EventSub reconnected');
        this.reconnectAttempts = 0;
        this.isConnecting = false;
      });

      ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

      ws.on('close', (code, reason) => {
        console.log(`[INFO] EventSub reconnection closed: ${code} ${reason?.toString()}`);
        this.scheduleReconnect();
      });

      ws.on('error', (error) => {
        console.error(`[ERROR] EventSub reconnection error: ${error.message}`);
        this.isConnecting = false;
        this.scheduleReconnect();
      });
    } catch (error) {
      console.error(`[ERROR] Failed to reconnect EventSub WebSocket: ${error}`);
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.keepaliveTimeout) {
      clearTimeout(this.keepaliveTimeout);
      this.keepaliveTimeout = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
    this.isConnecting = false;
  }
}
