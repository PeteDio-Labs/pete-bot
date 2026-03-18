import { BaseTool } from './BaseTool.js';
import { webSearchClient } from '../clients/index.js';
import type { ToolSchema, ToolResult } from '../ai/types.js';

export interface WebSearchToolArgs {
  action: 'search' | 'providers';
  query?: string;
  max_results?: number;
}

class WebSearchTool extends BaseTool<WebSearchToolArgs> {
  readonly name = 'web_search';

  readonly schema: ToolSchema = {
    name: 'web_search',
    description:
      'Search the web for current information, news, documentation, or facts. Use this when you need up-to-date information from the internet.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform: "search" to search the web, "providers" to list available search providers',
          enum: ['search', 'providers'],
        },
        query: {
          type: 'string',
          description: 'Search query (required for search action)',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return (default: 5, max: 20)',
        },
      },
      required: ['action'],
    },
  };

  async execute(args: WebSearchToolArgs): Promise<ToolResult> {
    try {
      switch (args.action) {
        case 'search':
          return await this.handleSearch(args.query, args.max_results);
        case 'providers':
          return await this.handleProviders();
        default:
          return { success: false, error: `Unknown action: ${args.action}` };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Web search error: ${msg}` };
    }
  }

  private async handleSearch(query?: string, maxResults = 5): Promise<ToolResult> {
    if (!query) {
      return { success: false, error: 'query is required for search action' };
    }

    const response = await webSearchClient.search(query, maxResults);
    return {
      success: true,
      action: 'search',
      query: response.query,
      provider: response.provider,
      resultCount: response.results.length,
      results: response.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
      })),
      metadata: response.metadata,
    };
  }

  private async handleProviders(): Promise<ToolResult> {
    const response = await webSearchClient.getProviders();
    return {
      success: true,
      action: 'providers',
      providers: response.providers,
    };
  }
}

export default new WebSearchTool();
