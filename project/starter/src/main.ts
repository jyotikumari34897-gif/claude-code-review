import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables
dotenv.config();

import { CodeReviewOrchestrator } from './orchestrator.js';
import { ReportGenerator } from './utils/report-generator.js';
import { logger } from './utils/logger.js';

/**
 * Main entry point for the Claude Multi-Agent Code Review System
 * Usage: npm run dev <owner> <repo> <pr-number>
 */
async function main() {
  const [owner, repo, prStr] = process.argv.slice(2);

  // Validate command line arguments
  if (!owner || !repo || !prStr) {
    console.error('Usage: npm run dev <owner> <repo> <pr-number>');
    console.error('Example: npm run dev facebook react 12345');
    process.exit(1);
  }

  const prNumber = parseInt(prStr, 10);
  if (isNaN(prNumber) || prNumber <= 0) {
    console.error(`Invalid PR number: "${prStr}". Must be a positive integer.`);
    process.exit(1);
  }

  // Validate authentication
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const hasAWSCredentials = !!process.env.AWS_ACCESS_KEY_ID && !!process.env.AWS_SECRET_ACCESS_KEY;

  if (hasAWSCredentials) {
    if (!process.env.AWS_REGION) {
      console.error('AWS_REGION is required when using AWS Bedrock authentication.');
      process.exit(1);
    }
    console.log('🔐 Using AWS Bedrock authentication');
  } else if (hasAnthropicKey) {
    console.log('🔐 Using Anthropic API authentication');
  } else {
    console.error(
      'No authentication configured. Please set one of:\n' +
      '  - ANTHROPIC_API_KEY (for Anthropic API)\n' +
      '  - AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (for AWS Bedrock)'
    );
    process.exit(1);
  }

  // Validate ANTHROPIC_MODEL
  if (!process.env.ANTHROPIC_MODEL) {
    console.error(
      'ANTHROPIC_MODEL is required. Set it in your .env file.\n' +
      '  For Anthropic API: claude-sonnet-4-5-20250929\n' +
      '  For AWS Bedrock:   us.anthropic.claude-sonnet-4-5-20250929-v1:0'
    );
    process.exit(1);
  }

  console.log(`\n🔍 Starting code review for ${owner}/${repo} PR #${prNumber}\n`);

  try {
    // Create orchestrator
    const orchestrator = new CodeReviewOrchestrator({
      rateLimits: {
        maxRequestsPerMinute: 50,
        maxTokensPerMinute: 100000,
        maxConcurrent: 5
      }
    });

    // Run the review
    const report = await orchestrator.reviewPullRequest(owner, repo, prNumber);

    // Generate reports
    const generator = new ReportGenerator();
    const markdown = generator.generateMarkdownReport(report);
    const html = generator.generateHTMLReport(report);
    const json = generator.generateJSONReport(report);

    // Ensure reports directory exists
    const reportsDir = 'reports';
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    // Save reports
    const prefix = `${owner}-${repo}-pr${prNumber}`;
    const mdPath = path.join(reportsDir, `${prefix}.md`);
    const htmlPath = path.join(reportsDir, `${prefix}.html`);
    const jsonPath = path.join(reportsDir, `${prefix}.json`);

    fs.writeFileSync(mdPath, markdown, 'utf-8');
    fs.writeFileSync(htmlPath, html, 'utf-8');
    fs.writeFileSync(jsonPath, json, 'utf-8');

    // Print summary to console
    console.log('\n' + '='.repeat(60));
    console.log('  CODE REVIEW COMPLETE');
    console.log('='.repeat(60));
    console.log(`  Overall Score:    ${report.summary.overallScore}/100`);
    console.log(`  Files Reviewed:   ${report.summary.totalFiles}`);
    console.log(`  Critical Issues:  ${report.summary.criticalIssues}`);
    console.log(`  Tests Needed:     ${report.summary.highPriorityTests}`);
    console.log(`  Refactorings:     ${report.summary.refactoringOpportunities}`);
    console.log('='.repeat(60));
    console.log('\n📄 Reports saved:');
    console.log(`  Markdown: ${mdPath}`);
    console.log(`  HTML:     ${htmlPath}`);
    console.log(`  JSON:     ${jsonPath}`);
    console.log();

    logger.info('Reports generated', { mdPath, htmlPath, jsonPath });
  } catch (error) {
    console.error('\n❌ Error during code review:', error instanceof Error ? error.message : String(error));
    logger.error('Code review failed', { error: String(error) });
    process.exit(1);
  }
}

main();
