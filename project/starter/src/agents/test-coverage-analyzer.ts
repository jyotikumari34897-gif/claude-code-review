import { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { TEST_COVERAGE_ANALYZER_PROMPT } from '../prompts/index.js';

/**
 * Test Coverage Analyzer Subagent
 * Identifies untested code paths and coverage gaps using extended thinking
 * for deeper analysis of complex branching logic.
 */
export const testCoverageAnalyzer: AgentDefinition = {
  description: 'Identifies untested code paths, missing test cases, and coverage gaps. Returns priority-based suggestions for improving test coverage.',
  prompt: TEST_COVERAGE_ANALYZER_PROMPT,
  tools: [],
  model: 'sonnet'
};
