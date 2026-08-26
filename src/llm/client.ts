import { LLMConfig } from '../config';
import { logger } from '../logger';

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'required' | 'none';
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
      content: string | null;
      tool_calls?: ToolCall[];
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

    logger.debug(`Full outgoing request: ${JSON.stringify(request, null, 2)}`);

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
            logger.error(`LLM server error: status=${response.status}, model=${this.config.model}, retry=${attempt}/${this.MAX_RETRIES}`);
            if (attempt < this.MAX_RETRIES) {
              await new Promise(resolve => setTimeout(resolve, 2000));
              continue;
            }
          } else if (response.status === 400 && body.includes('context')) {
            logger.error(`Context limit exceeded by LLM: ${body.substring(0, 150)}...`);
            return null;
          } else {
            logger.error(`LLM client error: status=${response.status} - ${body.substring(0, 200)}...`);
          }
          return null;
        }

        if (response.status === 200) {
          const data = await response.json() as ChatCompletionResponse;
          const content = data.choices?.[0]?.message?.content?.trim();

          if (!content) {
            logger.warn('LLM returned empty response');
            if (attempt < this.MAX_RETRIES) continue;
            return null;
          }

          // Log token usage if available
          if (data.usage) {
            logger.debug(`Token usage: prompt=${data.usage.prompt_tokens}, completion=${data.usage.completion_tokens}, total=${data.usage.total_tokens}`);
          }

          return content;
        }
      } catch (error: any) {
        if (error.name === 'AbortError') {
          logger.error(`LLM request timed out after ${this.config.timeout}ms`);
        } else {
          logger.error(`LLM request failed: ${error.message}`);
        }
        if (attempt < this.MAX_RETRIES) continue;
      }
    }

    logger.error('LLM max retries exceeded, giving up');
    return null;
  }

  async agenticToolCompletion(messages: ChatMessage[], tools: ToolDefinition[]): Promise<{ content: string | null; tool_calls: ToolCall[] | null } | null> {
    const request: ChatCompletionRequest = {
      model: this.config.model,
      messages,
      temperature: 0.3,
      max_tokens: 1000,
      tools,
      tool_choice: 'auto',
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
        const body = await response.text();
        logger.error(`LLM agentic tool request failed: HTTP ${response.status} - ${body.substring(0, 200)}`);
        return null;
      }

      const data = await response.json() as ChatCompletionResponse;
      const message = data.choices?.[0]?.message;
      if (!message) {
        logger.warn('LLM agentic tool response missing message');
        return null;
      }

      if (data.usage) {
        logger.debug(`Consolidation token usage: prompt=${data.usage.prompt_tokens}, completion=${data.usage.completion_tokens}, total=${data.usage.total_tokens}`);
      }

      return {
        content: message.content ?? null,
        tool_calls: message.tool_calls ?? null,
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        logger.error('LLM agentic tool request timed out');
      } else {
        logger.error(`LLM agentic tool request failed: ${error.message}`);
      }
      return null;
    }
  }

}
