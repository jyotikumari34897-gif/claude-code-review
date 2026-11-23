import { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { CODE_QUALITY_ANALYZER_PROMPT } from '../prompts/index.js';

/**
 * Code Quality Analyzer Subagent
 * Analyzes code for security, performance, and maintainability issues.
 * Invokes Claude Skills for language-specific guidance.
 */
export const codeQualityAnalyzer: AgentDefinition = {
  description: 'Analyzes code for security vulnerabilities, performance issues, and maintainability problems. Returns severity-leveled feedback with specific suggestions.',
  prompt: CODE_QUALITY_ANALYZER_PROMPT,
  // Uses Skill tool to load language-specific analysis guidance
  tools: ['Skill', 'Read'],
  model: 'sonnet'
};
