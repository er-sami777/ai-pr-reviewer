export type IssueType = 'error' | 'warning' | 'info' | 'suggestion';

export interface ReviewIssue {
  id: string;
  type: IssueType;
  file: string;
  line?: number;
  message: string;
  isCustom?: boolean;
  included?: boolean; // Whether to include in the final GitHub post
}

export interface ReviewResult {
  summary: string;
  overallAssessment: 'approve' | 'request_changes' | 'comment' | 'good_to_go';
  issues: ReviewIssue[];
  suggestions: string[];
}

export interface GitHubPR {
  number: number;
  title: string;
  body: string;
  state: string;
  user: {
    login: string;
    avatar_url: string;
  };
  head: {
    sha: string;
    ref: string;
  };
  base: {
    ref: string;
  };
  html_url: string;
  created_at: string;
  updated_at: string;
  draft?: boolean;
}

export interface GitHubFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  raw_url?: string;
}

export interface PRDetails {
  pr: GitHubPR;
  files: GitHubFile[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface ReviewHistoryItem {
  id: string;
  prUrl: string;
  title: string;
  owner: string;
  repo: string;
  prNumber: number;
  timestamp: number;
  assessment: 'approve' | 'request_changes' | 'comment' | 'good_to_go';
  issuesCount: number;
}

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  owner: {
    login: string;
    avatar_url: string;
  };
  html_url: string;
  description: string;
  private: boolean;
  updated_at: string;
  open_issues_count: number;
}

export interface WebhookEvent {
  id: string;
  type: 'opened' | 'synchronize' | 'reopened';
  repoFullName: string;
  prNumber: number;
  title: string;
  author: string;
  timestamp: number;
}
