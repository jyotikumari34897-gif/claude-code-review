import path from 'path';
import { fileURLToPath } from 'url';
import { query, AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { ReviewReport, ReviewReportSchema, ReviewReportJSONSchema } from './types/report-types.js';
import { mcpServersConfig } from './config/mcp.config.js';
import { codeQualityAnalyzer, testCoverageAnalyzer, refactoringSuggester } from './agents/index.js';
import { buildOrchestratorPrompt } from './prompts/index.js';
import { RateLimiter, DEFAULT_RATE_LIMITS, RateLimiterConfig } from './utils/rate-limiter.js';
import { logger, logReviewStart, logReviewComplete, logReviewError } from './utils/logger.js';
import { ReviewError, ErrorCodes, withRetry } from './utils/error-handler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Orchestrator configuration options
 */
export interface OrchestratorOptions {
  rateLimits?: Partial<RateLimiterConfig>;
  maxTurns?: number;
  timeoutMs?: number;
}

interface PRFile {
  filename: string;
  content: string;
}

/**
 * Main Code Review Orchestrator
 * Coordinates subagents to analyze pull requests and generate comprehensive reports
 */
export class CodeReviewOrchestrator {
  private rateLimiter: RateLimiter;
  private maxTurns: number;
  private projectRoot: string;

  constructor(options: OrchestratorOptions = {}) {
    this.rateLimiter = new RateLimiter(options.rateLimits ?? DEFAULT_RATE_LIMITS);
    this.maxTurns = options.maxTurns ?? 30;
    // PROJECT_ROOT points to the directory containing .claude/skills/
    this.projectRoot = process.env.PROJECT_ROOT ?? path.resolve(__dirname, '..');
  }

  /**
   * Review a pull request using parallel subagent analysis
   */
  async reviewPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewReport> {
    const startTime = Date.now();
    logReviewStart(owner, repo, prNumber);

    try {
      // Fetch PR files using GitHub MCP
      const files = await withRetry(
        () => this.fetchPRFiles(owner, repo, prNumber),
        3,
        1000
      );

      logger.info('Fetched PR files', { count: files.length, files: files.map(f => f.filename) });

      // Run multi-agent analysis
      const report = await this.runAgentAnalysis(owner, repo, prNumber, files, startTime);

      const duration = Date.now() - startTime;
      logReviewComplete(owner, repo, prNumber, report.summary.overallScore, duration);

      return report;
    } catch (error) {
      logReviewError(owner, repo, prNumber, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Fetch files from a PR using GitHub MCP
   */
  private async fetchPRFiles(owner: string, repo: string, prNumber: number): Promise<PRFile[]> {
    logger.info('Fetching PR files via GitHub MCP', { owner, repo, prNumber });

    const files: PRFile[] = [];

    const userMessage = `Use the GitHub MCP tools to:
1. Get the list of files changed in pull request #${prNumber} in repository ${owner}/${repo}
2. For each changed file (up to 10 files), fetch the file content

Return the results as a JSON array with this structure:
[
  {
    "filename": "path/to/file.ts",
    "content": "file content here"
  }
]

Only include source code files (skip binary files, lock files like package-lock.json, etc.)
If a file content cannot be fetched, include it with content as an empty string.`;

    async function* generateMessages(msg: string) {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: msg },
        parent_tool_use_id: null,
        session_id: `fetch-pr-${owner}-${repo}-${prNumber}`
      };
    }

    for await (const message of query({
      prompt: generateMessages(userMessage),
      options: {
        mcpServers: { github: mcpServersConfig.github },
        model: process.env.ANTHROPIC_MODEL,
        allowedTools: ['mcp__github__*'],
        maxTurns: 10
      }
    })) {
      if (message.type === 'result' && message.subtype === 'success') {
        // Try to parse JSON from the result
        try {
          const result = message.result;
          // Extract JSON array from the response
          const jsonMatch = result.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]) as Array<{ filename: string; content: string }>;
            files.push(...parsed);
          }
        } catch {
          logger.warn('Could not parse PR files from agent response, using empty list');
        }
      } else if (message.type === 'result') {
        const sub = (message as unknown as { subtype: string }).subtype;
        if (sub !== 'success') {
          throw new ReviewError(
            `Failed to fetch PR files: ${sub}`,
            ErrorCodes.GITHUB_API_ERROR,
            { owner, repo, prNumber }
          );
        }
      }
    }

    return files;
  }

  /**
   * Run multi-agent analysis on the PR files
   */
  private async runAgentAnalysis(
    owner: string,
    repo: string,
    prNumber: number,
    files: PRFile[],
    startTime: number
  ): Promise<ReviewReport> {
    const model = process.env.ANTHROPIC_MODEL;

    // Subagent registry — keyed names match what the orchestrator uses in Task calls
    const subagents: Record<string, AgentDefinition> = {
      'code-quality-analyzer': {
        ...codeQualityAnalyzer,
        // Pass project root so Skills tool can find .claude/skills/
        prompt: codeQualityAnalyzer.prompt
      },
      'test-coverage-analyzer': testCoverageAnalyzer,
      'refactoring-suggester': refactoringSuggester
    };

    const orchestratorPrompt = buildOrchestratorPrompt(owner, repo, prNumber, files);

    async function* generateMessages(msg: string) {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: msg },
        parent_tool_use_id: null,
        session_id: `review-${owner}-${repo}-${prNumber}`
      };
    }

    logger.info('Starting multi-agent analysis', { files: files.length });

    await this.rateLimiter.acquire(5000);

    try {
      for await (const message of query({
        prompt: generateMessages(orchestratorPrompt),
        options: {
          allowedTools: ['Task'],
          agents: subagents,
          model,
          cwd: this.projectRoot,
          settingSources: ['project'],
          outputFormat: {
            type: 'json_schema',
            schema: ReviewReportJSONSchema
          },
          maxTurns: this.maxTurns
        }
      })) {
        if (message.type === 'assistant') {
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_use' && block.name === 'Task') {
                const input = block.input as { description?: string };
                logger.debug('Spawning subagent', { task: input.description ?? 'unknown' });
              }
            }
          }
        } else if (message.type === 'result' && message.subtype === 'success') {
          this.rateLimiter.release();

          const duration = Date.now() - startTime;

          if (message.structured_output) {
            // Validate and return
            const parsed = ReviewReportSchema.safeParse(message.structured_output);
            if (parsed.success) {
              return parsed.data;
            }
            logger.warn('Zod validation failed on structured output, attempting repair', {
              errors: parsed.error.errors
            });
            // Attempt to repair with defaults and return
            return this.repairReport(message.structured_output as Record<string, unknown>, owner, repo, prNumber, duration);
          }

          // No structured output — build from text result
          logger.warn('No structured output received, building fallback report');
          return this.buildFallbackReport(owner, repo, prNumber, files, duration);
        } else if (message.type === 'result') {
          this.rateLimiter.release();
          throw new ReviewError(
            `Agent analysis failed: ${message.subtype}`,
            ErrorCodes.AGENT_FAILED,
            { subtype: message.subtype }
          );
        }
      }
    } catch (error) {
      this.rateLimiter.release();
      throw error;
    }

    throw new ReviewError('Agent analysis did not produce a result', ErrorCodes.AGENT_FAILED);
  }

  /**
   * Repair a partially valid structured output by filling in missing fields
   */
  private repairReport(
    raw: Record<string, unknown>,
    owner: string,
    repo: string,
    prNumber: number,
    duration: number
  ): ReviewReport {
    const fileReviews = Array.isArray(raw['fileReviews']) ? raw['fileReviews'] : [];
    const summary = (raw['summary'] as Record<string, unknown>) ?? {};

    return {
      pullRequest: { owner, repo, number: prNumber },
      fileReviews: fileReviews as ReviewReport['fileReviews'],
      summary: {
        totalFiles: (summary['totalFiles'] as number) ?? fileReviews.length,
        overallScore: (summary['overallScore'] as number) ?? 0,
        criticalIssues: (summary['criticalIssues'] as number) ?? 0,
        highPriorityTests: (summary['highPriorityTests'] as number) ?? 0,
        refactoringOpportunities: (summary['refactoringOpportunities'] as number) ?? 0
      },
      recommendations: Array.isArray(raw['recommendations']) ? raw['recommendations'] as ReviewReport['recommendations'] : [],
      metadata: {
        analyzedAt: new Date().toISOString(),
        duration,
        agentVersions: {
          'code-quality-analyzer': '1.0.0',
          'test-coverage-analyzer': '1.0.0',
          'refactoring-suggester': '1.0.0'
        }
      }
    };
  }

  /**
   * Build a fallback report when the agent didn't produce structured output
   */
  private buildFallbackReport(
    owner: string,
    repo: string,
    prNumber: number,
    files: PRFile[],
    duration: number
  ): ReviewReport {
    const fileReviews: ReviewReport['fileReviews'] = files.map(f => ({
      file: f.filename,
      codeQuality: {
        file: f.filename,
        issues: [],
        overallScore: 50,
        summary: 'Analysis could not complete for this file.'
      },
      testCoverage: {
        file: f.filename,
        hasTests: false,
        testFiles: [],
        untestedPaths: [],
        coverageEstimate: 0,
        summary: 'Coverage analysis could not complete for this file.'
      },
      refactorings: {
        file: f.filename,
        suggestions: [],
        summary: 'Refactoring analysis could not complete for this file.'
      }
    }));

    return {
      pullRequest: { owner, repo, number: prNumber },
      fileReviews,
      summary: {
        totalFiles: files.length,
        overallScore: 50,
        criticalIssues: 0,
        highPriorityTests: 0,
        refactoringOpportunities: 0
      },
      recommendations: [{
        priority: 'medium',
        category: 'Analysis',
        description: 'Full analysis could not be completed. Please retry or review files manually.',
        files: files.map(f => f.filename)
      }],
      metadata: {
        analyzedAt: new Date().toISOString(),
        duration,
        agentVersions: {
          'code-quality-analyzer': '1.0.0',
          'test-coverage-analyzer': '1.0.0',
          'refactoring-suggester': '1.0.0'
        }
      }
    };
  }
}
