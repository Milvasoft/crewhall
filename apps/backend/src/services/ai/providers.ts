import { anthropicClient } from './providers/anthropic';
import { chatClient } from './providers/chat';
import { geminiClient } from './providers/gemini';
import type { ModelClient, ModelConfig } from './providers/http';

/**
 * The model an org picked (yol haritası #5 and the provider list): the Claude API through its
 * SDK, Gemini through its own API, and everything else through the OpenAI chat-completions
 * protocol (OpenAI, Mistral, Azure OpenAI, OpenRouter, an own server). Every adapter streams
 * text and ends with token counts; the rest of the module does not know which one ran.
 */

export {
  ProviderError,
  sseData,
  type ModelChunk,
  type ModelClient,
  type ModelConfig,
  type ModelRequest,
  type ModelTool,
  type ModelTurn,
  type ProviderErrorKind,
  type ToolCall,
  type ToolPick,
} from './providers/http';

export function modelClient(config: ModelConfig): ModelClient {
  switch (config.provider) {
    case 'anthropic':
      return anthropicClient(config);
    case 'gemini':
      return geminiClient(config);
    default:
      return chatClient(config);
  }
}
