import { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { REFACTORING_SUGGESTER_PROMPT } from '../prompts/index.js';

/**
 * Refactoring Suggester Subagent
 * Finds modernization opportunities and structural improvements.
 * Provides before/after examples for each suggestion.
 */
export const refactoringSuggester: AgentDefinition = {
  description: 'Identifies refactoring opportunities including extract-function, modernization, simplification, and design pattern improvements. Provides before/after code examples.',
  prompt: REFACTORING_SUGGESTER_PROMPT,
  tools: [],
  model: 'haiku'
};
