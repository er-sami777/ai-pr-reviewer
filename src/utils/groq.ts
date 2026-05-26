import Groq from 'groq-sdk';
import type { ReviewResult, ReviewIssue, ChatMessage } from '../types';

// Initialize Groq client
const getGroqClient = (apiKey: string) => {
  return new Groq({ 
    apiKey, 
    dangerouslyAllowBrowser: true 
  });
};

export type ReviewProfile = 'comprehensive' | 'security' | 'performance' | 'refactoring';

export type GroqModelId = 
  | 'qwen/qwen3-32b'
  | 'llama-3.3-70b-versatile'
  | 'llama-3.1-8b-instant'
  | 'deepseek-r1-distill-llama-70b';

/**
 * Intelligently filter and truncate files to fit strict Groq Free Tier TPM limits
 */
function optimizeFilesForTokenLimit(
  files: Array<{ filename: string; patch: string }>,
  maxTokensTarget: number = 4200
): { optimizedFiles: Array<{ filename: string; patch: string }>; wasTruncated: boolean } {
  let wasTruncated = false;

  // 1. Filter out absolute fluff files immediately
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

  const relevantFiles = files.filter(f => 
    !ignoredPatterns.some(pattern => pattern.test(f.filename))
  );

  // 2. Estimate token usage (roughly ~3.8 characters per token for source code)
  const CHARS_PER_TOKEN = 3.8;
  let currentTotalChars = 0;
  const optimizedFiles: Array<{ filename: string; patch: string }> = [];

  // Sort files by relevance (smaller source files and main logic files first)
  const sortedFiles = [...relevantFiles].sort((a, b) => {
    // Prioritize critical extensions
    const getScore = (fname: string) => {
      if (fname.endsWith('.tsx') || fname.endsWith('.ts')) return 1;
      if (fname.endsWith('.jsx') || fname.endsWith('.js')) return 2;
      if (fname.endsWith('.py') || fname.endsWith('.go') || fname.endsWith('.rs')) return 2;
      return 5;
    };
    return getScore(a.filename) - getScore(b.filename);
  });

  for (const file of sortedFiles) {
    const fileHeaderChars = file.filename.length + 20;
    
    // If adding this entire file exceeds our character target
    if ((currentTotalChars + fileHeaderChars + file.patch.length) / CHARS_PER_TOKEN > maxTokensTarget) {
      wasTruncated = true;
      
      // Calculate how many characters we can still fit
      const remainingChars = (maxTokensTarget * CHARS_PER_TOKEN) - currentTotalChars - fileHeaderChars;
      
      if (remainingChars > 300) {
        // Truncate the patch and append a notice
        const truncatedPatch = file.patch.slice(0, remainingChars) + '\n\n... [DIFF TRUNCATED TO FIT GROQ FREE TIER TOKEN LIMITS]';
        optimizedFiles.push({ filename: file.filename, patch: truncatedPatch });
        currentTotalChars += fileHeaderChars + truncatedPatch.length;
      }
      
      // Stop adding more files to guarantee we stay safely below the TPM threshold
      break;
    } else {
      optimizedFiles.push(file);
      currentTotalChars += fileHeaderChars + file.patch.length;
    }
  }

  return { optimizedFiles, wasTruncated };
}

export async function reviewCode(
  apiKey: string,
  files: Array<{ filename: string; patch: string }>,
  prTitle: string,
  prDescription: string,
  reviewProfile: ReviewProfile = 'comprehensive',
  customGuidelines: string = '',
  modelId: GroqModelId = 'qwen/qwen3-32b'
): Promise<ReviewResult> {
  const client = getGroqClient(apiKey);

  let profileFocus = '';
  switch (reviewProfile) {
    case 'security':
      profileFocus = `Your absolute primary focus is on **Security Auditing**. Inspect the code for injection risks, hardcoded credentials, access controls, and XSS. Flag every potential security risk.`;
      break;
    case 'performance':
      profileFocus = `Your absolute primary focus is on **Performance Optimization**. Look for expensive loops, N+1 query patterns, unoptimized data structures, and excessive re-renders.`;
      break;
    case 'refactoring':
      profileFocus = `Your absolute primary focus is on **Code Cleanliness & Refactoring**. Identify code smells, overly complex functions, violations of DRY/SOLID principles, and poor naming.`;
      break;
    default:
      profileFocus = `## Your Review Focus Areas:
- **Security**: Potential vulnerabilities, hardcoded secrets, injection risks
- **Code Quality**: Readability, complexity, naming conventions, DRY principles
- **Performance**: Bottlenecks, inefficient algorithms, resource usage
- **Best Practices**: Following language/framework conventions`;
      break;
  }

  const customRulesSection = customGuidelines.trim()
    ? `\n## Custom Repository/Team Guidelines:\nYou MUST strictly adhere to these specific guidelines provided by the user:\n"${customGuidelines.trim()}"\nFlag any violations of these rules.`
    : '';

  const systemPrompt = `You are an expert code reviewer. Your job is to review GitHub Pull Requests and provide constructive, actionable feedback.

${profileFocus}
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

  // Intelligently optimize files to fit the strict free tier TPM limits
  // If the user selected a versatile model, we can allow slightly larger context
  const targetTokens = modelId === 'llama-3.3-70b-versatile' ? 5500 : 4000;
  const { optimizedFiles, wasTruncated } = optimizeFilesForTokenLimit(files, targetTokens);

  const filesContext = optimizedFiles.map(f => `### ${f.filename}\n\`\`\`diff\n${f.patch}\n\`\`\``).join('\n\n');

  const userPrompt = `Please review this Pull Request:

## PR Title: ${prTitle}

## PR Description: ${prDescription || 'No description provided.'}

## Changed Files:
${filesContext}

Please provide a comprehensive code review with your findings.`;

  try {
    const completion = await client.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      model: modelId,
      temperature: 0.1,
      max_tokens: modelId.startsWith('deepseek') ? 4096 : 2048,
    });

    const content = completion.choices[0]?.message?.content || '';
    
    // Try to parse JSON from the response
    let cleanedContent = content;
    cleanedContent = cleanedContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    
    const jsonMatch = cleanedContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      
      const issues: ReviewIssue[] = (parsed.issues || []).map((issue: any, index: number) => ({
        id: `ai-issue-${index}-${Date.now()}`,
        type: issue.type || 'info',
        file: issue.file || 'General',
        line: issue.line,
        message: issue.message || '',
        isCustom: false,
        included: true,
      }));

      // If files were truncated, append a warning suggestion so the user knows
      const suggestions = parsed.suggestions || [];
      if (wasTruncated) {
        suggestions.unshift(
          "⚠️ **Note**: Some large file diffs were truncated to comply with the Groq Free Tier Tokens-Per-Minute (TPM) limit. For complete file visibility, consider switching to the `llama-3.3-70b-versatile` model in the workspace settings."
        );
      }

      return {
        summary: parsed.summary || 'Review completed successfully.',
        overallAssessment: parsed.overallAssessment || 'comment',
        issues,
        suggestions,
      };
    }
    
    return {
      summary: cleanedContent.substring(0, 500) + '...',
      overallAssessment: 'comment',
      issues: [],
      suggestions: [
        'Could not parse structured JSON from the model response. Raw output provided in summary.',
        wasTruncated ? '⚠️ Some file diffs were truncated to comply with Groq Free Tier TPM limits.' : ''
      ].filter(Boolean),
    };
  } catch (error: any) {
    console.error('Groq API error:', error);
    
    // Intercept strict rate limits to provide high-fidelity fallback messages
    if (error?.status === 413 || error?.error?.code === 'rate_limit_exceeded') {
      throw new Error(
        `Groq API Rate Limit Exceeded: The requested file context is too large for the ${modelId} Free Tier. Please select the 'llama-3.3-70b-versatile' model from the top bar, or review fewer files simultaneously.`
      );
    }
    
    throw error;
  }
}

/**
 * Chat with the PR using Groq
 */
export async function chatWithPR(
  apiKey: string,
  files: Array<{ filename: string; patch: string }>,
  prTitle: string,
  prDescription: string,
  chatHistory: ChatMessage[],
  newMessage: string,
  modelId: GroqModelId = 'qwen/qwen3-32b'
): Promise<string> {
  const client = getGroqClient(apiKey);

  // Intelligently optimize files for chat context as well
  const { optimizedFiles } = optimizeFilesForTokenLimit(files, 3500);
  const filesContext = optimizedFiles.map(f => `### ${f.filename}\n\`\`\`diff\n${f.patch}\n\`\`\``).join('\n\n');

  const systemPrompt = `You are an expert coding assistant. You are assisting a developer reviewing a GitHub Pull Request.

## PR Title: ${prTitle}
## PR Description: ${prDescription || 'No description provided.'}

## Changed Files & Git Diffs:
${filesContext}

Answer the user's questions about this Pull Request accurately. Reference specific files and line numbers if applicable.`;

  const formattedMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
    ...chatHistory.map(m => ({
      role: m.role,
      content: m.content,
    })),
    { role: 'user', content: newMessage },
  ];

  try {
    const completion = await client.chat.completions.create({
      messages: formattedMessages,
      model: modelId,
      temperature: 0.3,
      max_tokens: 1536,
    });

    let content = completion.choices[0]?.message?.content || '';
    content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return content;
  } catch (error: any) {
    console.error('Groq Chat API error:', error);
    if (error?.status === 413 || error?.error?.code === 'rate_limit_exceeded') {
      throw new Error("Groq API Token Limit hit. Please clear the chat history or switch to a Versatile model tier.");
    }
    throw error;
  }
}
