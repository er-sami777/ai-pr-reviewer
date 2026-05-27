"""
GitHub REST API Client
======================
Asynchronous, fully-typed wrapper around the GitHub REST API
for fetching Pull Request metadata, file diffs, and posting review comments.
"""

from typing import Any, Optional
import httpx

from app.config import settings


GITHUB_API_BASE = "https://api.github.com"


def _get_headers() -> dict[str, str]:
    """Build the standard authorized request headers for GitHub API."""
    return {
        "Accept": "application/vnd.github.v3+json",
        "Authorization": f"token {settings.GITHUB_TOKEN}",
        "User-Agent": "AI-PR-Reviewer-Agent",
    }


async def fetch_pr_details(owner: str, repo: str, pr_number: int) -> dict[str, Any]:
    """
    Fetch the metadata of a specific Pull Request from GitHub.

    Args:
        owner: GitHub repository owner (user or organization).
        repo: GitHub repository name.
        pr_number: Numeric identifier of the Pull Request.

    Returns:
        Dictionary containing the PR metadata.

    Raises:
        httpx.HTTPStatusError: If the request fails.
    """
    url = f"{GITHUB_API_BASE}/repos/{owner}/{repo}/pulls/{pr_number}"

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(url, headers=_get_headers())
        response.raise_for_status()
        return response.json()


async def fetch_pr_files(owner: str, repo: str, pr_number: int) -> list[dict[str, Any]]:
    """
    Fetch the list of files modified in a Pull Request along with their diff patches.

    Args:
        owner: GitHub repository owner.
        repo: GitHub repository name.
        pr_number: PR number.

    Returns:
        List of file objects with their patches and metadata.
    """
    url = f"{GITHUB_API_BASE}/repos/{owner}/{repo}/pulls/{pr_number}/files?per_page=100"

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(url, headers=_get_headers())
        response.raise_for_status()
        return response.json()


async def post_pr_review_comment(
    owner: str,
    repo: str,
    pr_number: int,
    comment_body: str,
    event: str = "COMMENT",
) -> dict[str, Any]:
    """
    Post a complete review on the Pull Request with the AI-generated feedback.

    Args:
        owner: GitHub repository owner.
        repo: GitHub repository name.
        pr_number: PR number.
        comment_body: Markdown-formatted review content.
        event: Review type — 'COMMENT', 'APPROVE', or 'REQUEST_CHANGES'.

    Returns:
        Dictionary containing the created review object from GitHub.
    """
    url = f"{GITHUB_API_BASE}/repos/{owner}/{repo}/pulls/{pr_number}/reviews"

    payload = {
        "body": comment_body,
        "event": event,
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(url, headers=_get_headers(), json=payload)
        response.raise_for_status()
        return response.json()


async def post_pr_issue_comment(
    owner: str,
    repo: str,
    pr_number: int,
    comment_body: str,
) -> dict[str, Any]:
    """
    Post a plain issue comment (not a formal review) on a Pull Request.
    Useful as a fallback when formal review submission is restricted.
    """
    url = f"{GITHUB_API_BASE}/repos/{owner}/{repo}/issues/{pr_number}/comments"

    payload = {"body": comment_body}

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(url, headers=_get_headers(), json=payload)
        response.raise_for_status()
        return response.json()


async def fetch_full_pr_context(
    owner: str, repo: str, pr_number: int
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """
    Convenience helper: Fetch both PR metadata and modified files concurrently.

    Returns:
        Tuple of (pr_metadata, list_of_files).
    """
    import asyncio

    pr_task = asyncio.create_task(fetch_pr_details(owner, repo, pr_number))
    files_task = asyncio.create_task(fetch_pr_files(owner, repo, pr_number))

    pr_data = await pr_task
    files_data = await files_task

    return pr_data, files_data
