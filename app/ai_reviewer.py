"""
AI Reviewer Agent (Groq-Powered)
================================
Performs the first level of automated code review using the Groq inference API.
Loads user-defined coding standards from a Markdown file and produces
structured, actionable feedback in JSON format.
"""

import json
import re
from typing import Any
from groq import Groq

from app.config import settings, load_coding_standards


# ===== File Patterns to Skip =====
IGNORED_FILE_PATTERNS = [
    r"package-lock\.json$",
    r"yarn\.lock$",
    r"pnpm-lock\.yaml$",
    r"Pipfile\.lock$",
    r"poetry\.lock$",
    r"composer\.lock$",
    r"Gemfile\.lock$",
    r"\.svg$",
    r"\.png$",
    r"\.jpe?g$",
    r"\.gif$",
    r"\.ico$",
    r"\.webp$",
    r"\.snap$",
    r"\.min\.(js|css)$",
    r"dist/",
    r"build/",
    r"\.next/",
    r"node_modules/",
    r"__pycache__/",
]


def _should_skip_file(filename: str) -> bool:
    """Determine if a file should be excluded from AI review based on patterns."""
    return any(re.search(pattern, filename) for pattern in IGNORED_FILE_PATTERNS)


def _optimize_files_for_token_limit(
    files: list[dict[str, Any]],
    max_tokens_target: int = 4000,
) -> tuple[list[dict[str, Any]], bool]:
    """
    Intelligently filter and truncate files to fit strict Groq Free Tier limits.

    Returns:
        Tuple of (optimized_files, was_truncated_flag).
    """
    was_truncated = False
    chars_per_token = 3.8  # Approximate character-to-token ratio for source code

    # Filter out fluff files (lockfiles, binary assets, generated content)
    relevant_files = [
        f for f in files
        if not _should_skip_file(f.get("filename", ""))
        and f.get("patch")  # Only include files that have an inspectable diff
    ]

    # Sort by relevance — prioritize core source files
    def relevance_score(filename: str) -> int:
        if filename.endswith((".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java")):
            return 1
        if filename.endswith((".rb", ".php", ".kt", ".swift", ".cs", ".cpp", ".c")):
            return 2
        return 5

    relevant_files.sort(key=lambda f: relevance_score(f.get("filename", "")))

    optimized = []
    current_chars = 0

    for file in relevant_files:
        patch = file.get("patch", "")
        filename = file.get("filename", "unknown")
        header_chars = len(filename) + 20

        if (current_chars + header_chars + len(patch)) / chars_per_token > max_tokens_target:
            was_truncated = True
            remaining_chars = int((max_tokens_target * chars_per_token) - current_chars - header_chars)

            if remaining_chars > 300:
                truncated_patch = patch[:remaining_chars] + "\n\n... [DIFF TRUNCATED TO FIT TOKEN LIMITS]"
                optimized.append({"filename": filename, "patch": truncated_patch})
                current_chars += header_chars + len(truncated_patch)
            break
        else:
            optimized.append({"filename": filename, "patch": patch})
            current_chars += header_chars + len(patch)

    return optimized, was_truncated


def _build_system_prompt(coding_standards: str) -> str:
    """
    Construct the system-level prompt that instructs the AI on how to review.
    Injects the user-defined coding standards into the prompt context.
    """
    standards_block = ""
    if coding_standards.strip():
        standards_block = f"""

## ⚠️ MANDATORY TEAM CODING STANDARDS

You MUST strictly enforce these team-specific rules during your review. 
Flag every violation explicitly and reference the rule that was broken:

---
{coding_standards}
---
"""

    return f"""You are an expert senior software engineer performing the **first level of code review** on a GitHub Pull Request. Your goal is to provide constructive, actionable, and rigorous feedback before any human reviewer steps in.

## Your Review Focus Areas:
- **Security**: Hardcoded secrets, injection risks, broken authentication, XSS, insecure data handling.
- **Code Quality**: Readability, complexity, naming conventions, DRY principles, SOLID architecture.
- **Performance**: Bottlenecks, N+1 queries, inefficient algorithms, memory leaks, blocking I/O.
- **Best Practices**: Following language and framework conventions correctly.
- **Bug Detection**: Logic errors, edge cases, null pointer issues, race conditions.
- **Testing**: Adequate test coverage for the code modifications introduced.
{standards_block}

## Response Format:
You MUST respond in valid JSON format with the following structure:
{{
  "summary": "Brief overall summary of the PR review",
  "overallAssessment": "approve" | "request_changes" | "comment",
  "issues": [
    {{
      "type": "error" | "warning" | "info" | "suggestion",
      "file": "filename.ts",
      "line": 42,
      "message": "Detailed description of the issue and how to fix it"
    }}
  ],
  "suggestions": [
    "General high-level suggestion for improvement"
  ]
}}

Be thorough but concise. Output ONLY the JSON object with no markdown wrappers. Focus on the most impactful issues first. Reference specific file names and line numbers wherever applicable."""


async def review_pull_request(
    pr_title: str,
    pr_description: str,
    files: list[dict[str, Any]],
) -> dict[str, Any]:
    """
    Perform an AI-driven first-level code review on a Pull Request.

    Args:
        pr_title: The Pull Request title.
        pr_description: The PR body description.
        files: List of modified files with their patches.

    Returns:
        Dictionary with structured review feedback containing summary, 
        assessment, issues, and suggestions.
    """
    client = Groq(api_key=settings.GROQ_API_KEY)
    coding_standards = load_coding_standards()

    # Optimize files for token budget
    optimized_files, was_truncated = _optimize_files_for_token_limit(
        files, settings.MAX_TOKENS_PER_REVIEW
    )

    if not optimized_files:
        return {
            "summary": "No reviewable source code diffs were detected in this PR (only lockfiles, binary assets, or generated content).",
            "overallAssessment": "comment",
            "issues": [],
            "suggestions": [],
            "was_truncated": False,
        }

    # Build prompts
    system_prompt = _build_system_prompt(coding_standards)

    files_context = "\n\n".join(
        f"### {f['filename']}\n```diff\n{f['patch']}\n```" for f in optimized_files
    )

    user_prompt = f"""Please review this Pull Request rigorously and apply the team coding standards strictly.

## PR Title: {pr_title}

## PR Description:
{pr_description or 'No description provided.'}

## Changed Files:
{files_context}

Output a detailed structured JSON review with all detected issues and high-level recommendations."""

    # Make Groq API call
    try:
        completion = client.chat.completions.create(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            model=settings.GROQ_MODEL,
            temperature=0.1,
            max_tokens=2048,
        )

        raw_content = completion.choices[0].message.content or ""

        # Remove thinking blocks (qwen3-32b reasoning artifacts)
        cleaned = re.sub(r"<think>[\s\S]*?</think>", "", raw_content).strip()

        # Extract JSON object
        json_match = re.search(r"\{[\s\S]*\}", cleaned)
        if json_match:
            parsed = json.loads(json_match[0])
        else:
            parsed = {
                "summary": cleaned[:500],
                "overallAssessment": "comment",
                "issues": [],
                "suggestions": ["⚠️ The AI model did not return a structured response."],
            }

        parsed["was_truncated"] = was_truncated
        return parsed

    except json.JSONDecodeError as exc:
        return {
            "summary": f"Failed to parse AI response as JSON: {exc}",
            "overallAssessment": "comment",
            "issues": [],
            "suggestions": [],
            "was_truncated": was_truncated,
        }
    except Exception as exc:
        raise RuntimeError(f"Groq API error: {exc}") from exc


def format_review_as_markdown(review_result: dict[str, Any], model_id: str) -> str:
    """
    Convert the structured AI review result into a beautifully formatted 
    Markdown string suitable for posting directly to GitHub.
    """
    assessment_emoji = {
        "approve": "✅",
        "request_changes": "❌",
        "comment": "💬",
        "good_to_go": "✔️",
    }

    assessment = review_result.get("overallAssessment", "comment")
    summary = review_result.get("summary", "Review completed.")
    issues = review_result.get("issues", [])
    suggestions = review_result.get("suggestions", [])
    was_truncated = review_result.get("was_truncated", False)

    markdown = f"## 🤖 Autonomous AI Code Review (First Level)\n\n"
    label = "GOOD TO GO" if assessment == "good_to_go" else assessment.replace("_", " ").upper()
    markdown += f"### {assessment_emoji.get(assessment, '💬')} Overall Assessment: **{label}**\n\n"
    markdown += f"### 📋 Executive Summary\n{summary}\n\n"

    if issues:
        markdown += f"### 🔍 Detailed Findings ({len(issues)} issues)\n\n"

        grouped: dict[str, list] = {}
        for issue in issues:
            file = issue.get("file", "General")
            grouped.setdefault(file, []).append(issue)

        icons = {
            "error": "🔴",
            "warning": "🟡",
            "info": "🔵",
            "suggestion": "💡",
        }

        for file, file_issues in grouped.items():
            markdown += f"#### 📁 `{file}`\n\n"
            for issue in file_issues:
                icon = icons.get(issue.get("type", "info"), "🔵")
                line = issue.get("line")
                message = issue.get("message", "")
                line_prefix = f"**Line {line}**: " if line else ""
                markdown += f"- {icon} {line_prefix}{message}\n"
            markdown += "\n"
    else:
        markdown += "*No critical issues identified in this Pull Request.*\n\n"

    if suggestions:
        markdown += "### 💡 High-Level Strategic Recommendations\n\n"
        for suggestion in suggestions:
            markdown += f"- {suggestion}\n"

    if was_truncated:
        markdown += (
            "\n\n> ⚠️ **Note**: Some diff patches were truncated to comply with "
            "Groq token-per-minute limits. Consider configuring a higher-capacity model."
        )

    markdown += (
        f"\n\n---\n*🤖 First-level review generated autonomously by **Groq AI** "
        f"utilizing the **{model_id}** inference model.*\n"
        f"*A human reviewer will perform the second-level review.*"
    )

    return markdown
