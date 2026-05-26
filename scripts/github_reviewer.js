#!/usr/bin/env node

/**
 * ============================================================================
 * 🤖 OPTION B: STANDALONE AUTONOMOUS AI PR REVIEWER SCRIPT
 * ============================================================================
 * 
 * This script provides a fully automated, standalone execution environment 
 * designed for local terminals, cron jobs, and GitHub Actions CI/CD workflows.
 * 
 * It reads configuration from the environment (or a local .env file), 
 * connects directly to the GitHub REST API to obtain PR diff patches, 
 * forwards them to Groq's high-speed LPU inference engine, and publishes 
 * beautifully styled code review feedback directly back to the Pull Request.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Groq from 'groq-sdk';

// 1. Manually parse local .env file if available
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '../.env');

if (fs.existsSync(envPath)) {
  console.log('📦 Loading configuration from local .env file...');
  const envConfig = fs.readFileSync(envPath, 'utf-8');
  envConfig.split('\n').forEach(line => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      // Strip 'VITE_' prefix if present to allow unified access, but support both
      const cleanKey = key.replace(/^VITE_/, '');
      const val = match[2].trim().replace(/^["']|["']$/g, '');
      if (!process.env[cleanKey]) process.env[cleanKey] = val;
      if (!process.env[key]) process.env[key] = val;
    }
  });
}

// 2. Load and validate configuration
const GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.VITE_GITHUB_TOKEN;
const MODEL_ID = process.env.DEFAULT_MODEL || process.env.VITE_DEFAULT_MODEL || 'qwen/qwen3-32b';
const CUSTOM_GUIDELINES = process.env.CUSTOM_GUIDELINES || process.env.VITE_CUSTOM_GUIDELINES || '';

// Target repository parameters
// Can be supplied via GitHub Actions native env vars or CLI arguments
const REPO_OWNER = process.env.REPO_OWNER || process.env.GITHUB_REPOSITORY_OWNER;
const REPO_NAME = process.env.REPO_NAME || (process.env.GITHUB_REPOSITORY ? process.env.GITHUB_REPOSITORY.split('/')[1] : null);
const PR_NUMBER = process.env.PR_NUMBER || process.env.PULL_NUMBER;

// Helper to exit gracefully
function fatalError(msg) {
  console.error(`\n❌ [FATAL ERROR]: ${msg}`);
  console.error('\nUsage Examples:');
  console.error('  # Run locally against a specific PR:');
  console.error('  REPO_OWNER=facebook REPO_NAME=react PR_NUMBER=28900 node scripts/github_reviewer.js');
  console.error('\n  # Or rely on your configured .env file and native GitHub Actions runner parameters.');
  process.exit(1);
}

if (!GROQ_API_KEY) {
  fatalError('Groq API Key is missing. Please define GROQ_API_KEY in your environment or local .env file.');
}

if (!GITHUB_TOKEN) {
  fatalError('GitHub Personal Access Token is missing. Please define GITHUB_TOKEN in your environment or local .env file.');
}

if (!REPO_OWNER || !REPO_NAME || !PR_NUMBER) {
  fatalError('Target Pull Request parameters are incomplete. Please define REPO_OWNER, REPO_NAME, and PR_NUMBER.');
}

console.log(`\n==================================================`);
console.log(`🤖 OPTION B: AUTONOMOUS AI PR REVIEWER`);
console.log(`==================================================`);
console.log(`Target PR:   https://github.com/${REPO_OWNER}/${REPO_NAME}/pull/${PR_NUMBER}`);
console.log(`Groq Model:  ${MODEL_ID}`);
console.log(`Guidelines:  ${CUSTOM_GUIDELINES ? 'Active' : 'None'}`);
console.log(`==================================================\n`);

// Initialize Groq SDK safely
const groq = new Groq({ apiKey: GROQ_API_KEY });

/**
 * Fetch Pull Request Metadata and File Diffs from GitHub API
 */
async function fetchPullRequestFiles() {
  console.log('📡 Fetching Pull Request metadata and file patches from GitHub...');
  
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'Authorization': `token ${GITHUB_TOKEN}`,
    'User-Agent': 'Autonomous-AI-PR-Reviewer-Agent',
  };

  // 1. Fetch PR details
  const prRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}`, { headers });
  if (!prRes.ok) {
    throw new Error(`Failed to fetch PR details: ${prRes.status} ${prRes.statusText}`);
  }
  const pr = await prRes.json();

  // 2. Fetch modified files
  const filesRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}/files`, { headers });
  if (!filesRes.ok) {
    throw new Error(`Failed to fetch PR files: ${filesRes.status} ${filesRes.statusText}`);
  }
  const files = await filesRes.json();

  return { pr, files };
}

/**
 * Intelligently filter and truncate files to fit strict Groq Free Tier TPM limits
 */
function optimizeFilesForTokenLimit(files, maxTokensTarget = 4200) {
  let wasTruncated = false;

  const ignoredPatterns = [
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,
    /\.svg$/,
    /\.png$/,
    /\.jpg$/,
    /\.snap$/,
    /dist\//,
    /build\//,
  ];

  const relevantFiles = files.filter(f => !ignoredPatterns.some(pattern => pattern.test(f.filename)));

  const CHARS_PER_TOKEN = 3.8;
  let currentTotalChars = 0;
  const optimizedFiles = [];

  for (const file of relevantFiles) {
    if (!file.patch) continue;
    
    const fileHeaderChars = file.filename.length + 20;
    if ((currentTotalChars + fileHeaderChars + file.patch.length) / CHARS_PER_TOKEN > maxTokensTarget) {
      wasTruncated = true;
      const remainingChars = (maxTokensTarget * CHARS_PER_TOKEN) - currentTotalChars - fileHeaderChars;
      
      if (remainingChars > 300) {
        const truncatedPatch = file.patch.slice(0, remainingChars) + '\n\n... [DIFF TRUNCATED TO FIT GROQ FREE TIER TOKEN LIMITS]';
        optimizedFiles.push({ filename: file.filename, patch: truncatedPatch });
        currentTotalChars += fileHeaderChars + truncatedPatch.length;
      }
      break;
    } else {
      optimizedFiles.push({ filename: file.filename, patch: file.patch });
      currentTotalChars += fileHeaderChars + file.patch.length;
    }
  }

  return { optimizedFiles, wasTruncated };
}

/**
 * Main Execution Workflow
 */
async function runAutonomousReview() {
  try {
    const { pr, files } = await fetchPullRequestFiles();
    
    console.log(`📋 Pull Request Title: "${pr.title}"`);
    console.log(`📁 Changed Files: ${files.length}`);

    // Optimize Diff for Groq API
    const targetTokens = MODEL_ID.includes('70b') ? 5500 : 4000;
    const { optimizedFiles, wasTruncated } = optimizeFilesForTokenLimit(files, targetTokens);

    if (optimizedFiles.length === 0) {
      console.log('✅ No reviewable source code diffs found (only lockfiles, binary, or untracked formats). Skipping AI analysis.');
      process.exit(0);
    }

    const filesContext = optimizedFiles.map(f => `### ${f.filename}\n\`\`\`diff\n${f.patch}\n\`\`\``).join('\n\n');

    const customRulesSection = CUSTOM_GUIDELINES.trim()
      ? `\n## Custom Repository/Team Guidelines:\nYou MUST strictly adhere to these specific guidelines provided by the user:\n"${CUSTOM_GUIDELINES.trim()}"\nFlag any violations of these rules.`
      : '';

    const systemPrompt = `You are an expert code reviewer. Your job is to review GitHub Pull Requests and provide constructive, actionable feedback.

## Your Review Focus Areas:
- **Security**: Potential vulnerabilities, hardcoded secrets, injection risks
- **Code Quality**: Readability, complexity, naming conventions, DRY principles
- **Performance**: Bottlenecks, inefficient algorithms, resource usage
- **Best Practices**: Following language/framework conventions
${customRulesSection}

## Response Format:
You MUST respond in valid JSON format with the following structure:
{
  "summary": "Brief overall summary of the PR review",
  "overallAssessment": "approve" | "request_changes" | "comment",
  "issues": [
    {
      "type": "error" | "warning" | "info" | "suggestion",
      "file": "filename.ts",
      "line": 42,
      "message": "Description of the issue"
    }
  ],
  "suggestions": [
    "General suggestion for improvement"
  ]
}

Ensure the output is 100% valid JSON. Do not include markdown code block wrappers around the JSON if it breaks parsing. Focus on the most important issues.`;

    const userPrompt = `Please review this Pull Request:

## PR Title: ${pr.title}

## PR Description: ${pr.body || 'No description provided.'}

## Changed Files:
${filesContext}

Please provide a comprehensive code review with your findings.`;

    console.log(`⚡ Forwarding optimized patch diffs to Groq LPU (${MODEL_ID})...`);

    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      model: MODEL_ID,
      temperature: 0.1,
      max_tokens: MODEL_ID.startsWith('deepseek') ? 4096 : 2048,
    });

    let content = completion.choices[0]?.message?.content || '';
    content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    // Try to parse JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    let reviewResult;

    if (jsonMatch) {
      reviewResult = JSON.parse(jsonMatch[0]);
    } else {
      console.warn('⚠️ Model output was not strict JSON. Wrapping raw response.');
      reviewResult = {
        summary: content.substring(0, 1000) + '\n\n*Raw Model Output inside Summary due to JSON parsing format output.*',
        overallAssessment: 'comment',
        issues: [],
        suggestions: [],
      };
    }

    // Format final review markdown
    const assessmentEmoji = {
      approve: '✅',
      request_changes: '❌',
      comment: '💬',
    };

    let markdown = `## 🤖 Autonomous AI Code Review\n\n`;
    markdown += `### ${assessmentEmoji[reviewResult.overallAssessment] || '💬'} Overall Assessment: **${(reviewResult.overallAssessment || 'comment').replace('_', ' ').toUpperCase()}**\n\n`;
    markdown += `### 📋 Executive Summary\n${reviewResult.summary}\n\n`;

    if (reviewResult.issues && reviewResult.issues.length > 0) {
      markdown += `### 🔍 Detailed Findings\n\n`;
      
      const groupedIssues = reviewResult.issues.reduce((acc, issue) => {
        const key = issue.file || 'General';
        if (!acc[key]) acc[key] = [];
        acc[key].push(issue);
        return acc;
      }, {});

      for (const [file, issues] of Object.entries(groupedIssues)) {
        markdown += `#### 📁 \`${file}\`\n\n`;
        for (const issue of issues) {
          const icons = {
            error: '🔴',
            warning: '🟡',
            info: '🔵',
            suggestion: '💡',
          };
          const icon = icons[issue.type] || '🔵';
          markdown += `- ${icon} ${issue.line ? `**Line ${issue.line}**: ` : ''}${issue.message}\n`;
        }
        markdown += '\n';
      }
    } else {
      markdown += `*No critical architectural or security issues were found in this source diff.*\n\n`;
    }

    if (reviewResult.suggestions && reviewResult.suggestions.length > 0) {
      markdown += `### 💡 High-Level Recommendations\n\n`;
      for (const suggestion of reviewResult.suggestions) {
        markdown += `- ${suggestion}\n`;
      }
    }

    if (wasTruncated) {
      markdown += `\n\n> ⚠️ **Note**: Some large file diffs were truncated to comply with the Groq Free Tier Tokens-Per-Minute (TPM) limit.`;
    }

    markdown += `\n\n---\n*Review generated autonomously by **Groq AI** utilizing the **${MODEL_ID}** model.*`;

    // Post to GitHub
    console.log(`📤 Publishing formatted review back to GitHub PR #${PR_NUMBER}...`);

    const commentRes = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues/${PR_NUMBER}/comments`,
      {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Autonomous-AI-PR-Reviewer-Agent',
        },
        body: JSON.stringify({ body: markdown }),
      }
    );

    if (!commentRes.ok) {
      const errData = await commentRes.json();
      throw new Error(`Failed to post review comment: ${errData.message || commentRes.statusText}`);
    }

    console.log('🎉 [SUCCESS]: Autonomous AI PR Review posted successfully!');

  } catch (error) {
    console.error(`\n❌ [ERROR]: Execution failed:`, error.message);
    process.exit(1);
  }
}

// Trigger Execution
runAutonomousReview();
