// GitHub API utilities for fetching PR details
import type { GitHubRepository, GitHubPR, GitHubFile, PRDetails } from '../types';

/**
 * Parse GitHub URL to extract owner and repo
 */
export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const patterns = [
    // https://github.com/owner/repo
    /github\.com\/([^/]+)\/([^/]+)\/?$/,
    // https://github.com/owner/repo/pull/123
    /github\.com\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return { owner: match[1], repo: match[2].replace('.git', '') };
    }
  }

  return null;
}

/**
 * Fetch all accessible repositories for the authenticated user
 */
export async function fetchUserRepositories(token: string): Promise<GitHubRepository[]> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'Authorization': `token ${token}`,
  };

  // Fetch repositories with user/org permissions sorted by recently updated
  const response = await fetch(
    'https://api.github.com/user/repos?sort=updated&per_page=100',
    { headers }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch repositories: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Fetch all open Pull Requests for a given repository
 */
export async function fetchRepositoryPullRequests(
  owner: string,
  repo: string,
  token?: string
): Promise<GitHubPR[]> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
  };

  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=50`,
    { headers }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch pull requests for ${owner}/${repo}: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Fetch PR details from GitHub API
 */
export async function fetchPRDetails(
  owner: string,
  repo: string,
  prNumber: number,
  token?: string
): Promise<PRDetails> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
  };

  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  // Fetch PR details
  const prResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    { headers }
  );

  if (!prResponse.ok) {
    throw new Error(`Failed to fetch PR: ${prResponse.status} ${prResponse.statusText}`);
  }

  const pr: GitHubPR = await prResponse.json();

  // Fetch PR files
  const filesResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`,
    { headers }
  );

  if (!filesResponse.ok) {
    throw new Error(`Failed to fetch PR files: ${filesResponse.status} ${filesResponse.statusText}`);
  }

  const files: GitHubFile[] = await filesResponse.json();

  return { pr, files };
}

/**
 * Post a review comment on a PR
 */
export async function postReviewComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  token: string
): Promise<void> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'Authorization': `token ${token}`,
    'Content-Type': 'application/json',
  };

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        body,
        event: 'COMMENT',
      }),
    }
  );

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Failed to post review: ${errorData.message || response.statusText}`);
  }
}

/**
 * Get rate limit status
 */
export async function getRateLimit(token?: string): Promise<{ remaining: number; limit: number }> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
  };

  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  const response = await fetch('https://api.github.com/rate_limit', { headers });
  const data = await response.json();

  return {
    remaining: data.resources.core.remaining,
    limit: data.resources.core.limit,
  };
}
