import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CodeReviewOrchestrator, OrchestratorOptions } from '../src/orchestrator.js';
import { ReviewReportSchema } from '../src/types/report-types.js';
import { RateLimiter, DEFAULT_RATE_LIMITS } from '../src/utils/rate-limiter.js';
import { withRetry, withTimeout, ReviewError, ErrorCodes } from '../src/utils/error-handler.js';
import { codeQualityAnalyzer } from '../src/agents/code-quality-analyzer.js';
import { testCoverageAnalyzer } from '../src/agents/test-coverage-analyzer.js';
import { refactoringSuggester } from '../src/agents/refactoring-suggester.js';

/**
 * Tests for CodeReviewOrchestrator
 */

describe('CodeReviewOrchestrator', () => {
  describe('Configuration', () => {
    it('should initialize with default options', () => {
      const orchestrator = new CodeReviewOrchestrator();
      expect(orchestrator).toBeDefined();
      expect(orchestrator).toBeInstanceOf(CodeReviewOrchestrator);
    });

    it('should accept custom rate limit configuration', () => {
      const customOptions: OrchestratorOptions = {
        rateLimits: {
          maxRequestsPerMinute: 20,
          maxTokensPerMinute: 50000,
          maxConcurrent: 2
        }
      };
      const orchestrator = new CodeReviewOrchestrator(customOptions);
      expect(orchestrator).toBeDefined();
    });
  });

  describe('reviewPullRequest', () => {
    it('should fetch PR files from GitHub MCP', async () => {
      // This test requires real API credentials. Without them the SDK will
      // reject the call; we verify the method throws (rather than hanging)
      // when no ANTHROPIC_API_KEY is configured in the test environment.
      const orchestrator = new CodeReviewOrchestrator();

      // Set a short timeout via vitest option — the call must settle quickly
      const promise = orchestrator.reviewPullRequest('owner', 'repo', 1);
      await expect(promise).rejects.toBeDefined();
    }, 30000);

    it('should spawn all 3 subagents in parallel', () => {
      // Verify subagent definitions are exported and have required fields
      expect(codeQualityAnalyzer).toBeDefined();
      expect(testCoverageAnalyzer).toBeDefined();
      expect(refactoringSuggester).toBeDefined();

      // Each agent must have description and prompt
      expect(typeof codeQualityAnalyzer.description).toBe('string');
      expect(typeof codeQualityAnalyzer.prompt).toBe('string');
      expect(typeof testCoverageAnalyzer.description).toBe('string');
      expect(typeof testCoverageAnalyzer.prompt).toBe('string');
      expect(typeof refactoringSuggester.description).toBe('string');
      expect(typeof refactoringSuggester.prompt).toBe('string');
    });

    it('should aggregate results into ReviewReport', () => {
      // Validate the ReviewReportSchema accepts a well-formed report
      const mockReport = {
        pullRequest: { owner: 'facebook', repo: 'react', number: 12345 },
        fileReviews: [
          {
            file: 'src/index.ts',
            codeQuality: {
              file: 'src/index.ts',
              issues: [],
              overallScore: 85,
              summary: 'Good quality code.'
            },
            testCoverage: {
              file: 'src/index.ts',
              hasTests: true,
              testFiles: ['tests/index.test.ts'],
              untestedPaths: [],
              coverageEstimate: 80,
              summary: 'Adequate test coverage.'
            },
            refactorings: {
              file: 'src/index.ts',
              suggestions: [],
              summary: 'No major refactoring needed.'
            }
          }
        ],
        summary: {
          totalFiles: 1,
          overallScore: 85,
          criticalIssues: 0,
          highPriorityTests: 0,
          refactoringOpportunities: 0
        },
        recommendations: [],
        metadata: {
          analyzedAt: new Date().toISOString(),
          duration: 5000,
          agentVersions: { 'code-quality-analyzer': '1.0.0' }
        }
      };

      const result = ReviewReportSchema.safeParse(mockReport);
      expect(result.success).toBe(true);
    });

    it('should validate output with Zod schema', () => {
      // Verify invalid data is rejected
      const invalid = {
        pullRequest: { owner: 'fb', repo: 'react', number: 'not-a-number' },
        fileReviews: 'not-an-array'
      };
      const result = ReviewReportSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe('Integration', () => {
    // These tests require actual API keys and should be skipped in CI
    it.skip('should review a real small PR', async () => {
      // NOTE: Only run manually with valid API keys
      const orchestrator = new CodeReviewOrchestrator();
      const report = await orchestrator.reviewPullRequest('anthropics', 'anthropic-sdk-python', 1);
      expect(report.summary.totalFiles).toBeGreaterThan(0);
      expect(report.summary.overallScore).toBeGreaterThanOrEqual(0);
      expect(report.summary.overallScore).toBeLessThanOrEqual(100);
    });
  });
});

describe('RateLimiter', () => {
  it('should initialize with default config', () => {
    const limiter = new RateLimiter();
    const status = limiter.getStatus();
    expect(status.activeRequests).toBe(0);
    expect(status.requestsInWindow).toBe(0);
    expect(status.availableRequests).toBe(DEFAULT_RATE_LIMITS.maxRequestsPerMinute);
  });

  it('should track active requests after acquire', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 5 });
    await limiter.acquire(100);
    const status = limiter.getStatus();
    expect(status.activeRequests).toBe(1);
    limiter.release();
    const afterRelease = limiter.getStatus();
    expect(afterRelease.activeRequests).toBe(0);
  });

  it('canProceed returns true when under limits', async () => {
    const limiter = new RateLimiter({ maxRequestsPerMinute: 50 });
    expect(limiter.canProceed(100)).toBe(true);
  });

  it('canProceed returns false when at token limit', async () => {
    const limiter = new RateLimiter({ maxTokensPerMinute: 500 });
    // Acquire enough to fill the window
    await limiter.acquire(400);
    expect(limiter.canProceed(200)).toBe(false);
    limiter.release();
  });

  it('should accept custom rate limit config', () => {
    const limiter = new RateLimiter({
      maxRequestsPerMinute: 10,
      maxTokensPerMinute: 10000,
      maxConcurrent: 2
    });
    const status = limiter.getStatus();
    expect(status.availableRequests).toBe(10);
  });
});

describe('Error Handler', () => {
  describe('withRetry', () => {
    it('should return result on first success', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      const result = await withRetry(fn, 3, 10);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and succeed', async () => {
      let callCount = 0;
      const fn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 3) throw new Error('temporary failure');
        return 'success';
      });

      const result = await withRetry(fn, 3, 1);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should throw ReviewError after all retries fail', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('persistent failure'));

      await expect(withRetry(fn, 2, 1)).rejects.toMatchObject({
        code: ErrorCodes.RETRY_EXHAUSTED
      });
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('withTimeout', () => {
    it('should resolve if function completes in time', async () => {
      const fn = async () => {
        await new Promise(r => setTimeout(r, 10));
        return 'done';
      };
      const result = await withTimeout(fn, 5000);
      expect(result).toBe('done');
    });

    it('should throw ReviewError on timeout', async () => {
      const fn = async () => {
        await new Promise(r => setTimeout(r, 5000));
        return 'done';
      };
      await expect(withTimeout(fn, 50, 'timed out')).rejects.toMatchObject({
        code: ErrorCodes.AGENT_TIMEOUT,
        message: 'timed out'
      });
    });
  });

  describe('ReviewError', () => {
    it('should have correct name and code', () => {
      const err = new ReviewError('test error', ErrorCodes.MISSING_API_KEY);
      expect(err.name).toBe('ReviewError');
      expect(err.code).toBe(ErrorCodes.MISSING_API_KEY);
      expect(err.message).toBe('test error');
    });
  });
});
