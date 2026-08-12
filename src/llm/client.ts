import { LLMConfig } from '../config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class LLMClient {
  private config: LLMConfig;
  private readonly MAX_RETRIES = 1;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  async chatCompletion(messages: ChatMessage[]): Promise<string | null> {
    const request: ChatCompletionRequest = {
      model: this.config.model,
      messages,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
    };

    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

        const response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const body = await response.text();
          if (response.status >= 500) {
            console.error(`[ERROR] LLM request failed: status=${response.status}, endpoint=/v1/chat/completions, model=${this.config.model}, retry=${attempt}/${this.MAX_RETRIES}`);
            if (attempt < this.MAX_RETRIES) {
              await new Promise(resolve => setTimeout(resolve, 2000));
              continue;
            }
          } else {
            console.error(`[ERROR] LLM request failed (client error): status=${response.status}, body=${body}`);
          }
          return null;
        }

        if (response.status === 200) {
          const data = await response.json() as ChatCompletionResponse;
          const content = data.choices?.[0]?.message?.content?.trim();

          if (!content) {
            console.warn('[WARN] LLM returned empty response, retrying...');
            if (attempt < this.MAX_RETRIES) continue;
            return null;
          }

          return content;
        }
      } catch (error: any) {
        if (error.name === 'AbortError') {
          console.error(`[ERROR] LLM request timed out after ${this.config.timeout}ms`);
        } else {
          console.error(`[ERROR] LLM request failed: ${error.message}`);
        }
        if (attempt < this.MAX_RETRIES) continue;
      }
    }

    console.error(`[ERROR] LLM max retries exceeded`);
    return null;
  }

  async consolidationCompletion(messages: ChatMessage[]): Promise<string | null> {
    const request: ChatCompletionRequest = {
      model: this.config.model,
      messages,
      temperature: 0.3,
      max_tokens: 1000,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.error(`[ERROR] LLM consolidation request failed: HTTP ${response.status}`);
        return null;
      }

      const data = await response.json() as ChatCompletionResponse;
      return data.choices?.[0]?.message?.content?.trim() ?? null;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.error('[ERROR] LLM consolidation request timed out');
      } else {
        console.error(`[ERROR] LLM consolidation request failed: ${error.message}`);
      }
      return null;
    }
  }
}
