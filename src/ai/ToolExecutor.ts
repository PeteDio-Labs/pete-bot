// Tool Executor - handles tool call execution loop
import type { Message } from 'ollama';
import type { OllamaClient } from './OllamaClient.js';
import { registry } from './ToolRegistry.js';
import type {
  ToolExecutionRecord,
  ProcessMessageResult,
  OnToolCallCallback,
  ToolResult,
} from './types.js';
import { toolExecutionsTotal, toolExecutionDuration } from '../metrics/index.js';
import { getSummarizer } from './SummarizerClient.js';
import { logger } from '../utils/index.js';

// Tools that should have their results summarized by the small model
const SUMMARIZABLE_TOOLS = new Set(['qbittorrent']);

// Tool usage hints - concise guidance for the AI on how to use each tool
const TOOL_HINTS: Record<string, string> = {
  qbittorrent: `Actions: list (show torrents, optional filter: downloading|seeding|completed|paused|active), details (requires hash), speeds, transfer_info. Use "list" for "show downloads" questions.`,
  calculate: `Evaluate math expressions. Examples: "2+2", "sqrt(16)", "pow(2,8)". Supports +,-,*,/,% and functions: sqrt, pow, sin, cos, tan, log, abs, ceil, floor, round, PI, E.`,
  get_current_time: `Get current time. Optional timezone param (IANA format: "America/New_York", "Europe/London"). Defaults to UTC.`,
  mission_control: `Actions: inventory_summary, workload_status (optional namespace), list_apps, app_status (requires app), sync_app (requires app), node_status, recent_events (optional limit), availability. Use this as the default tool for Mission Control, homelab, ArgoCD, Proxmox, and alert questions.`,
  infrastructure: `Actions: inventory_summary (all hosts & workloads), node_status (Proxmox nodes with CPU/memory), workload_status (optional namespace filter). Use inventory_summary for "what's running" questions.`,
  argocd: `Actions: list_apps (all ArgoCD apps with sync/health), app_status (requires app name), sync_app (requires app name). Use list_apps for general status questions.`,
  alerts: `Actions: recent_events (optional limit, default 10). Returns recent infrastructure events and alerts.`,
};

export class ToolExecutor {
  private readonly ollamaClient: OllamaClient;
  private readonly maxIterations: number;

  constructor(ollamaClient: OllamaClient, maxIterations = 5) {
    this.ollamaClient = ollamaClient;
    this.maxIterations = maxIterations;
  }

  /**
   * Build a concise system prompt with tool hints for registered tools only
   */
  private buildSystemPrompt(): string {
    const toolNames = registry.getToolNames();
    const hints = toolNames
      .map((name) => TOOL_HINTS[name] ? `• ${name}: ${TOOL_HINTS[name]}` : null)
      .filter(Boolean)
      .join('\n');

    return `You are a helpful assistant with tools. Use the simplest approach to answer questions. Don't ask for parameters unless required.

Tools:
${hints}`;
  }

  /**
   * Process a user message, executing tools as needed
   */
  async processMessage(
    userMessage: string,
    onToolCall?: OnToolCallCallback
  ): Promise<ProcessMessageResult> {
    const messages: Message[] = [
      { role: 'system', content: this.buildSystemPrompt() },
      { role: 'user', content: userMessage }
    ];
    const tools = registry.getToolSchemas();
    const toolsUsed: ToolExecutionRecord[] = [];
    let iterations = 0;

    while (iterations < this.maxIterations) {
      iterations++;

      // Call Ollama with tools
      const response = await this.ollamaClient.chat(messages, tools);
      const toolCalls = response.message.tool_calls;

      // Check if there are tool calls to process
      if (!toolCalls || toolCalls.length === 0) {
        // No more tool calls - return final response
        return {
          response: response.message.content || 'No response generated',
          toolsUsed,
        };
      }

      // Add assistant message with tool calls to history
      messages.push(response.message);

      // Process each tool call
      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        const toolArgs = (toolCall.function.arguments ?? {}) as Record<string, unknown>;

        // Notify about tool call
        onToolCall?.(toolName, toolArgs);

        // Execute the tool with timing
        const tool = registry.get(toolName);
        let result: ToolResult;
        const start = Date.now();
        if (!tool) {
          result = { success: false, error: `Unknown tool: ${toolName}` };
          // Track unknown tool as error
          toolExecutionsTotal.labels(toolName, 'error').inc();
        } else {
          try {
            result = await tool.execute(toolArgs);
            // Track successful execution
            toolExecutionsTotal.labels(toolName, 'success').inc();
          } catch (error) {
            result = {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
            };
            // Track failed execution
            toolExecutionsTotal.labels(toolName, 'error').inc();
          }
        }
        const durationMs = Date.now() - start;
        const durationSeconds = durationMs / 1000;
        
        // Record duration metric
        toolExecutionDuration.labels(toolName).observe(durationSeconds);
        
        // Detailed logging for debugging
        logger.debug(`[ToolExecutor] Tool '${toolName}' executed in ${durationMs}ms`);
        logger.debug(`[ToolExecutor] Args: ${JSON.stringify(toolArgs)}`);
        logger.debug(`[ToolExecutor] Result: ${JSON.stringify(result).substring(0, 500)}`);

        toolsUsed.push({ name: toolName, args: toolArgs, result, durationMs });

        // Summarize result using small model if applicable
        let resultContent = JSON.stringify(result);
        const summarizer = getSummarizer();

        if (summarizer && SUMMARIZABLE_TOOLS.has(toolName) && result.success) {
          try {
            logger.debug(`[ToolExecutor] Summarizing ${toolName} result with small model...`);
            const summary = await summarizer.summarize(result, userMessage);
            resultContent = JSON.stringify({ success: true, summary });
            logger.debug(`[ToolExecutor] Summary: ${summary.substring(0, 200)}`);
          } catch (summarizeError) {
            logger.debug(`[ToolExecutor] Summarization failed, using raw result: ${summarizeError}`);
            // Fall back to raw JSON if summarization fails
          }
        }

        // Add tool result to conversation
        messages.push({
          role: 'tool',
          content: resultContent,
        });
      }
    }

    // Max iterations reached
    return {
      response: 'Maximum tool iterations reached. Please try a simpler question.',
      toolsUsed,
    };
  }
}

export default ToolExecutor;
