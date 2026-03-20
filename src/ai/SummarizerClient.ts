// Summarizer Client - uses a small/fast Ollama model to summarize tool results
import { Ollama } from 'ollama';
import { config } from '../config.js';
import { logger } from '../utils/index.js';

export interface SummarizerConfig {
  host: string;
  model: string;
  timeout?: number;
  client?: Ollama; // Optional for dependency injection in tests
}

/**
 * Lightweight Ollama client for summarizing structured data
 * Uses a small model (e.g., qwen2.5:3b) for fast inference
 */
export class SummarizerClient {
  private readonly client: Ollama;
  private readonly model: string;
  private readonly timeout: number;

  constructor(cfg: SummarizerConfig) {
    this.client = cfg.client ?? new Ollama({ host: cfg.host });
    this.model = cfg.model;
    this.timeout = cfg.timeout ?? 30000;
  }

  /**
   * Summarize structured data based on user's question context
   * @param data - The raw JSON data from a tool result
   * @param userQuestion - The original user question for context
   * @returns A concise, user-friendly summary
   */
  async summarize(data: object, userQuestion: string): Promise<string> {
    const systemPrompt = `You are a concise assistant that summarizes JSON data into user-friendly text. Always respond in English.
Rules:
- Always respond in English
- Be brief and direct
- Format numbers nicely (e.g., bytes to MB/GB, speeds as MB/s)
- Use bullet points for lists
- Don't explain what you're doing, just provide the summary
- Match the tone of the user's question`;

    const userPrompt = `User asked: "${userQuestion}"

Here is the data to summarize:
${JSON.stringify(data, null, 2)}

Provide a concise, friendly summary:`;

    try {
      const response = await this.client.chat({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: false,
      });

      return response.message.content || 'Unable to summarize data.';
    } catch (error) {
      logger.error('[SummarizerClient] Error:', error);
      // Fallback: return a basic JSON string if summarization fails
      return `Data: ${JSON.stringify(data)}`;
    }
  }

  /**
   * Check if the summarizer model is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const models = await this.client.list();
      const modelBase = this.model.split(':')[0] ?? this.model;
      return models.models.some((m) => m.name?.startsWith(modelBase) ?? false);
    } catch {
      return false;
    }
  }
}

// Singleton instance (only created if summarizer is enabled)
let summarizerInstance: SummarizerClient | null = null;

export function getSummarizer(): SummarizerClient | null {
  if (!config.summarizer.enabled) {
    return null;
  }

  if (!summarizerInstance) {
    summarizerInstance = new SummarizerClient({
      host: config.ollama.host,
      model: config.summarizer.model,
    });
  }

  return summarizerInstance;
}

export default SummarizerClient;
