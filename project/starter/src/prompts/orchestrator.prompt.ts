/**
 * Orchestrator Prompt Builder
 */

export const buildOrchestratorPrompt = (
  owner: string,
  repo: string,
  prNumber: number,
  files: Array<{ filename: string; content: string }>
): string => {
  const fileList = files.map(f => `- ${f.filename}`).join('\n');

  return `You are a code review orchestrator coordinating specialized subagents for a comprehensive PR analysis.

## Pull Request Details
- Repository: ${owner}/${repo}
- PR Number: #${prNumber}
- Files Changed: ${files.length}

## Files to Review
${fileList}

## Your Subagents (via Task tool)
You have three specialized subagents:
- **code-quality-analyzer**: Analyzes security, performance, and maintainability issues
- **test-coverage-analyzer**: Identifies untested code paths and coverage gaps
- **refactoring-suggester**: Finds modernization and structural improvement opportunities

## Instructions
For EACH file listed above, spawn ALL THREE subagents IN PARALLEL.

For each file, include the file path and content in the task description so the subagent can analyze it.

Pass the file content to each subagent like this:
"Analyze file [filename]: [content]"

After all subagents complete for all files, compile the results into a comprehensive review report.

## Important
- Launch subagent tasks for ALL files in parallel when possible
- Each file needs all 3 subagents run on it
- Aggregate the results accurately into the final report structure

Begin the analysis now.`;
};
