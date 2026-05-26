import { useState, useEffect, useMemo } from 'react';
import { 
  fetchPRDetails, 
  postReviewComment, 
  parseGitHubUrl, 
  fetchUserRepositories, 
  fetchRepositoryPullRequests 
} from './utils/github';
import { reviewCode, chatWithPR, type ReviewProfile, type GroqModelId } from './utils/groq';
import type { 
  ReviewResult, 
  ReviewIssue, 
  IssueType, 
  GitHubFile, 
  ChatMessage, 
  ReviewHistoryItem,
  PRDetails,
  GitHubRepository,
  GitHubPR,
  WebhookEvent
} from './types';
import { cn } from './utils/cn';

function App() {
  // Configuration state with seamless .env fallbacks
  const [groqApiKey, setGroqApiKey] = useState(() => 
    localStorage.getItem('groq_api_key') || import.meta.env.VITE_GROQ_API_KEY || ''
  );
  const [githubToken, setGithubToken] = useState(() => 
    localStorage.getItem('github_token') || import.meta.env.VITE_GITHUB_TOKEN || ''
  );
  const [customGuidelines, setCustomGuidelines] = useState(() =>
    localStorage.getItem('custom_guidelines') || import.meta.env.VITE_CUSTOM_GUIDELINES || ''
  );

  // PR input state
  const [prUrl, setPrUrl] = useState('');
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [prNumber, setPrNumber] = useState('');
  const [inputMode, setInputMode] = useState<'url' | 'manual'>('url');
  const [reviewProfile, setReviewProfile] = useState<ReviewProfile>('comprehensive');
  const [selectedModel, setSelectedModel] = useState<GroqModelId>(() => 
    (localStorage.getItem('groq_model_id') as GroqModelId) || (import.meta.env.VITE_DEFAULT_MODEL as GroqModelId) || 'qwen/qwen3-32b'
  );

  // Live Explorer State
  const [landingTab, setLandingTab] = useState<'audit' | 'explorer' | 'webhooks'>('audit');
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [repoPRCounts, setRepoPRCounts] = useState<Record<number, number>>({});
  const [selectedRepoForPRs, setSelectedRepoForPRs] = useState<GitHubRepository | null>(null);
  const [repoPullRequests, setRepoPullRequests] = useState<GitHubPR[]>([]);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [isLoadingPRs, setIsLoadingPRs] = useState(false);
  const [repoSearch, setRepoSearch] = useState('');

  // Webhook Engine State
  const [isPollingEnabled, setIsPollingEnabled] = useState(() => 
    localStorage.getItem('webhook_polling_enabled') === 'true'
  );
  const [detectedEvents, setDetectedEvents] = useState<WebhookEvent[]>([]);
  const [lastPollTime, setLastPollTime] = useState<Date | null>(null);

  // Loaded Data
  const [prDetails, setPrDetails] = useState<PRDetails | null>(null);
  const [reviewResult, setReviewResult] = useState<ReviewResult | null>(null);

  // UI state
  const [activeTab, setActiveTab] = useState<'review' | 'files' | 'chat' | 'overview'>('review');
  const [selectedFile, setSelectedFile] = useState<GitHubFile | null>(null);

  // Loading state
  const [isLoading, setIsLoading] = useState(false);
  const [isPosting, setIsPosting] = useState(false);
  const [loadingStep, setLoadingStep] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Settings modal
  const [showSettings, setShowSettings] = useState(false);

  // Custom Comment modal
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [customFile, setCustomFile] = useState('General');
  const [customLine, setCustomLine] = useState('');
  const [customType, setCustomType] = useState<IssueType>('suggestion');
  const [customMessage, setCustomMessage] = useState('');

  // Chat State
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [currentChatMessage, setCurrentChatMessage] = useState('');
  const [isChatting, setIsChatting] = useState(false);

  // History State
  const [reviewHistory, setReviewHistory] = useState<ReviewHistoryItem[]>(() => {
    try {
      const saved = localStorage.getItem('review_history');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Save settings to localStorage
  const saveSettings = () => {
    localStorage.setItem('groq_api_key', groqApiKey);
    localStorage.setItem('github_token', githubToken);
    localStorage.setItem('custom_guidelines', customGuidelines);
    localStorage.setItem('groq_model_id', selectedModel);
    setShowSettings(false);
    setSuccessMessage('Settings saved successfully!');
    setTimeout(() => setSuccessMessage(null), 3000);
  };

  const handleModelChange = (modelId: GroqModelId) => {
    setSelectedModel(modelId);
    localStorage.setItem('groq_model_id', modelId);
    setSuccessMessage(`Switched model to ${modelId}`);
    setTimeout(() => setSuccessMessage(null), 2500);
  };

  // Fetch Repositories for the active user account
  const handleFetchRepositories = async () => {
    if (!githubToken) {
      setError('Please provide a GitHub Personal Access Token in the workspace settings to browse private & public repositories.');
      setShowSettings(true);
      return;
    }

    setIsLoadingRepos(true);
    setError(null);
    try {
      const repos = await fetchUserRepositories(githubToken);
      setRepositories(repos);

      // Background query to precisely count actual open Pull Requests for each repository
      // We prioritize repositories that have open issues to optimize performance
      const counts: Record<number, number> = {};
      for (const repoObj of repos.slice(0, 30)) { // Monitor top 30 active repositories
        if (repoObj.open_issues_count > 0) {
          try {
            const prs = await fetchRepositoryPullRequests(repoObj.owner.login, repoObj.name, githubToken);
            counts[repoObj.id] = prs.length;
          } catch {
            counts[repoObj.id] = 0;
          }
        } else {
          counts[repoObj.id] = 0;
        }
      }
      setRepoPRCounts(counts);

    } catch (err: any) {
      console.error('Failed to fetch repositories:', err);
      setError(err.message || 'Failed to fetch repositories from GitHub.');
    } finally {
      setIsLoadingRepos(false);
    }
  };

  // Select a repository to query its real-time open pull requests
  const handleSelectRepo = async (repoObj: GitHubRepository) => {
    setSelectedRepoForPRs(repoObj);
    setIsLoadingPRs(true);
    setError(null);
    try {
      const prs = await fetchRepositoryPullRequests(repoObj.owner.login, repoObj.name, githubToken);
      setRepoPullRequests(prs);
      
      // Update count perfectly
      setRepoPRCounts(prev => ({ ...prev, [repoObj.id]: prs.length }));
    } catch (err: any) {
      console.error('Failed to fetch PRs:', err);
      setError(err.message || `Failed to fetch open pull requests for ${repoObj.full_name}.`);
    } finally {
      setIsLoadingPRs(false);
    }
  };

  // Trigger review directly from an Explorer PR item
  const handleSelectExplorerPR = (prObj: GitHubPR, repoObj: GitHubRepository) => {
    setOwner(repoObj.owner.login);
    setRepo(repoObj.name);
    setPrNumber(prObj.number.toString());
    setPrUrl(prObj.html_url);
    setInputMode('url');
    setLandingTab('audit'); // Automatically transition to the On-Demand Audit tab to bring the trigger button into the active DOM
    
    // Automatically trigger review fetch
    setTimeout(() => {
      const reviewBtn = document.getElementById('review-trigger-btn');
      if (reviewBtn) reviewBtn.click();
    }, 100);
  };

  // Background Live Webhook & Polling Emulation
  useEffect(() => {
    if (!isPollingEnabled || !githubToken) return;

    // Fetch initial repos if not loaded to track their PRs
    let trackedRepos = repositories;

    const pollForNewPRs = async () => {
      try {
        if (trackedRepos.length === 0) {
          const freshRepos = await fetchUserRepositories(githubToken);
          trackedRepos = freshRepos.slice(0, 8);
          setRepositories(freshRepos);
        }

        const now = Date.now();
        const newEvents: WebhookEvent[] = [];
        
        // Track the currently open pull requests across all monitored repositories
        // This lets us actively purge notifications for any PR that gets merged or closed!
        const activePRKeys = new Set<string>();

        for (const repoObj of trackedRepos.slice(0, 8)) {
          try {
            const prs = await fetchRepositoryPullRequests(repoObj.owner.login, repoObj.name, githubToken);
            
            for (const pr of prs) {
              activePRKeys.add(`${repoObj.full_name}#${pr.number}`);
              
              const createdTime = new Date(pr.created_at).getTime();
              const updatedTime = new Date(pr.updated_at).getTime();
              
              if (now - createdTime < 3 * 60 * 1000) {
                newEvents.push({
                  id: `webhook-${pr.number}-${createdTime}`,
                  type: 'opened',
                  repoFullName: repoObj.full_name,
                  prNumber: pr.number,
                  title: pr.title,
                  author: pr.user.login,
                  timestamp: createdTime,
                });
              } else if (now - updatedTime < 3 * 60 * 1000) {
                newEvents.push({
                  id: `webhook-${pr.number}-${updatedTime}`,
                  type: 'synchronize',
                  repoFullName: repoObj.full_name,
                  prNumber: pr.number,
                  title: pr.title,
                  author: pr.user.login,
                  timestamp: updatedTime,
                });
              }
            }
          } catch (e) {
            // Silently skip
          }
        }

        // Dynamically update events: 
        // 1. Filter out any existing event whose target PR is no longer present in the open list
        // 2. Prepend unique new events
        setDetectedEvents(prev => {
          const validExisting = prev.filter(evt => activePRKeys.has(`${evt.repoFullName}#${evt.prNumber}`));
          
          if (newEvents.length > 0) {
            const existingIds = new Set(validExisting.map(evt => evt.id));
            const uniqueNew = newEvents.filter(evt => !existingIds.has(evt.id));
            return [...uniqueNew, ...validExisting].slice(0, 20);
          }
          
          return validExisting;
        });

        setLastPollTime(new Date());
      } catch (err) {
        console.error('Webhook Polling Error:', err);
      }
    };

    // Run initial poll immediately
    pollForNewPRs();

    // Set up polling interval every 45 seconds
    const intervalId = setInterval(pollForNewPRs, 45 * 1000);
    return () => clearInterval(intervalId);
  }, [isPollingEnabled, githubToken, repositories]);

  const toggleWebhookPolling = () => {
    const nextState = !isPollingEnabled;
    setIsPollingEnabled(nextState);
    localStorage.setItem('webhook_polling_enabled', String(nextState));
    setSuccessMessage(nextState ? '🔌 Live Webhook / PR Polling Engine Activated!' : '🔌 Live Webhook Engine Paused.');
    setTimeout(() => setSuccessMessage(null), 3000);
  };

  // Parse PR URL
  const handleUrlChange = (url: string) => {
    setPrUrl(url);
    const parsed = parseGitHubUrl(url);
    if (parsed) {
      setOwner(parsed.owner);
      setRepo(parsed.repo);
    }
    const prMatch = url.match(/\/pull\/(\d+)/);
    if (prMatch) {
      setPrNumber(prMatch[1]);
    }
  };

  // Main review function
  const handleReview = async () => {
    if (!groqApiKey) {
      setError('Please configure your Groq API key in settings');
      setShowSettings(true);
      return;
    }

    let reviewOwner = owner;
    let reviewRepo = repo;
    let reviewPrNumber = parseInt(prNumber);

    if (inputMode === 'url') {
      const parsed = parseGitHubUrl(prUrl);
      if (!parsed) {
        setError('Invalid GitHub URL. Please enter a valid PR URL.');
        return;
      }
      reviewOwner = parsed.owner;
      reviewRepo = parsed.repo;
      
      const prMatch = prUrl.match(/\/pull\/(\d+)/);
      if (!prMatch) {
        setError('Could not extract PR number from URL. Please include the PR number.');
        return;
      }
      reviewPrNumber = parseInt(prMatch[1]);
    }

    if (!reviewOwner || !reviewRepo || !reviewPrNumber) {
      setError('Please provide all required fields (owner, repo, PR number)');
      return;
    }

    setIsLoading(true);
    setError(null);
    setSuccessMessage(null);
    setReviewResult(null);
    setPrDetails(null);
    setChatHistory([]);

    try {
      // Step 1: Fetch PR details
      setLoadingStep('Fetching Pull Request metadata and file patches from GitHub...');
      const details = await fetchPRDetails(reviewOwner, reviewRepo, reviewPrNumber, githubToken);
      setPrDetails(details);

      // Select first file by default for the file diff explorer
      if (details.files.length > 0) {
        setSelectedFile(details.files[0]);
      }

      // Step 2: Review with AI
      setLoadingStep(`Analyzing ${details.files.length} changed files using Groq Qwen3-32B...`);
      
      const filesForReview = details.files
        .filter(f => f.patch)
        .map(f => ({
          filename: f.filename,
          patch: f.patch || '',
        }));

      const result = await reviewCode(
        groqApiKey,
        filesForReview,
        details.pr.title,
        details.pr.body || '',
        reviewProfile,
        customGuidelines,
        selectedModel
      );

      setReviewResult(result);
      setActiveTab('review');

      // Save to History
      const newHistoryItem: ReviewHistoryItem = {
        id: `${reviewOwner}-${reviewRepo}-${reviewPrNumber}`,
        prUrl: details.pr.html_url,
        title: details.pr.title,
        owner: reviewOwner,
        repo: reviewRepo,
        prNumber: reviewPrNumber,
        timestamp: Date.now(),
        assessment: result.overallAssessment,
        issuesCount: result.issues.length,
      };

      setReviewHistory(prev => {
        const filtered = prev.filter(item => item.id !== newHistoryItem.id);
        const updated = [newHistoryItem, ...filtered].slice(0, 20); // Keep last 20
        localStorage.setItem('review_history', JSON.stringify(updated));
        return updated;
      });

    } catch (err) {
      console.error('Review failed:', err);
      setError(err instanceof Error ? err.message : 'An error occurred during review');
    } finally {
      setIsLoading(false);
      setLoadingStep('');
    }
  };

  // Load a history item
  const handleLoadHistory = async (item: ReviewHistoryItem) => {
    setOwner(item.owner);
    setRepo(item.repo);
    setPrNumber(item.prNumber.toString());
    setPrUrl(item.prUrl);
    setInputMode('url');
    setLandingTab('audit'); // Instantly transition back to the On-Demand Audit tab to bring the trigger button into the active DOM
    
    // Automatically trigger review fetch
    // Use timeout to allow state updates
    setTimeout(() => {
      const reviewBtn = document.getElementById('review-trigger-btn');
      if (reviewBtn) reviewBtn.click();
    }, 100);
  };

  // Toggle issue inclusion
  const toggleIssueInclusion = (id: string) => {
    if (!reviewResult) return;
    setReviewResult(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        issues: prev.issues.map(issue => 
          issue.id === id ? { ...issue, included: !issue.included } : issue
        ),
      };
    });
  };

  // Delete an issue
  const deleteIssue = (id: string) => {
    if (!reviewResult) return;
    setReviewResult(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        issues: prev.issues.filter(issue => issue.id !== id),
      };
    });
  };

  // Add Custom Comment
  const handleAddCustomComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reviewResult) return;

    const newIssue: ReviewIssue = {
      id: `custom-issue-${Date.now()}`,
      type: customType,
      file: customFile,
      line: customLine ? parseInt(customLine) : undefined,
      message: customMessage,
      isCustom: true,
      included: true,
    };

    setReviewResult(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        issues: [newIssue, ...prev.issues],
      };
    });

    // Reset Form
    setCustomMessage('');
    setCustomLine('');
    setShowCustomModal(false);
    setSuccessMessage('Custom comment added successfully!');
    setTimeout(() => setSuccessMessage(null), 3000);
  };

  // Post to GitHub
  const handlePostToGitHub = async () => {
    if (!reviewResult || !githubToken || !prDetails) {
      setError('Please configure your GitHub token and complete a review first');
      return;
    }

    setIsPosting(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const reviewMarkdown = formatReviewAsMarkdown(reviewResult);
      
      await postReviewComment(
        prDetails.pr.base.ref ? owner : parseGitHubUrl(prUrl)?.owner || owner,
        prDetails.pr.base.ref ? repo : parseGitHubUrl(prUrl)?.repo || repo,
        prDetails.pr.number,
        reviewMarkdown,
        githubToken
      );

      setSuccessMessage('🎉 Review successfully posted to the GitHub Pull Request!');
    } catch (err) {
      console.error('Failed to post review:', err);
      setError(err instanceof Error ? err.message : 'Failed to post review to GitHub');
    } finally {
      setIsPosting(false);
    }
  };

  // Format review as markdown for GitHub
  const formatReviewAsMarkdown = (result: ReviewResult): string => {
    const assessmentEmoji: Record<string, string> = {
      approve: '✅',
      request_changes: '❌',
      comment: '💬',
      good_to_go: '✔️',
    };

    let markdown = `## 🤖 AI Code Review (${reviewProfile.toUpperCase()} Audit)\n\n`;
    const label = result.overallAssessment === 'good_to_go' ? 'GOOD TO GO' : result.overallAssessment.replace('_', ' ').toUpperCase();
    markdown += `### ${assessmentEmoji[result.overallAssessment] || '💬'} Overall Assessment: **${label}**\n\n`;
    markdown += `### 📋 Executive Summary\n${result.summary}\n\n`;

    const includedIssues = result.issues.filter(i => i.included !== false);

    if (includedIssues.length > 0) {
      markdown += `### 🔍 Detailed Findings\n\n`;
      
      const groupedIssues = includedIssues.reduce((acc, issue) => {
        const key = issue.file || 'General';
        if (!acc[key]) acc[key] = [];
        acc[key].push(issue);
        return acc;
      }, {} as Record<string, ReviewIssue[]>);

      for (const [file, issues] of Object.entries(groupedIssues)) {
        markdown += `#### 📁 \`${file}\`\n\n`;
        for (const issue of issues) {
          const icons: Record<string, string> = {
            error: '🔴',
            warning: '🟡',
            info: '🔵',
            suggestion: '💡',
          };
          const icon = icons[issue.type] || '🔵';
          
          const customBadge = issue.isCustom ? ' **[User Comment]**' : '';
          markdown += `- ${icon} ${issue.line ? `**Line ${issue.line}**: ` : ''}${issue.message}${customBadge}\n`;
        }
        markdown += '\n';
      }
    } else {
      markdown += `*No critical issues were selected for this review report.*\n\n`;
    }

    if (result.suggestions && result.suggestions.length > 0) {
      markdown += `### 💡 High-Level Recommendations\n\n`;
      for (const suggestion of result.suggestions) {
        markdown += `- ${suggestion}\n`;
      }
    }

    markdown += `\n---\n*Review powered by **Groq AI** utilizing Alibaba's **Qwen3-32B** model.*`;

    return markdown;
  };

  // Handle Chat message
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentChatMessage.trim() || !prDetails || !groqApiKey) return;

    const userMsg = currentChatMessage;
    setCurrentChatMessage('');

    const newHistory: ChatMessage[] = [
      ...chatHistory,
      { id: `user-${Date.now()}`, role: 'user', content: userMsg, timestamp: new Date() },
    ];
    setChatHistory(newHistory);
    setIsChatting(true);

    try {
      const filesForReview = prDetails.files
        .filter(f => f.patch)
        .map(f => ({
          filename: f.filename,
          patch: f.patch || '',
        }));

      const reply = await chatWithPR(
        groqApiKey,
        filesForReview,
        prDetails.pr.title,
        prDetails.pr.body || '',
        newHistory,
        userMsg,
        selectedModel
      );

      setChatHistory(prev => [
        ...prev,
        { id: `assistant-${Date.now()}`, role: 'assistant', content: reply, timestamp: new Date() },
      ]);
    } catch (err) {
      console.error('Chat error:', err);
      setChatHistory(prev => [
        ...prev,
        { 
          id: `error-${Date.now()}`, 
          role: 'assistant', 
          content: '⚠️ Failed to get a response from the model. Please verify your Groq API key.', 
          timestamp: new Date() 
        },
      ]);
    } finally {
      setIsChatting(false);
    }
  };

  // Calculate file summary stats
  const fileStats = useMemo(() => {
    if (!prDetails) return null;
    const additions = prDetails.files.reduce((sum, f) => sum + f.additions, 0);
    const deletions = prDetails.files.reduce((sum, f) => sum + f.deletions, 0);
    return { additions, deletions, count: prDetails.files.length };
  }, [prDetails]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-purple-500 selection:text-white">
      {/* Premium Header */}
      <header className="sticky top-0 z-40 bg-slate-900/80 backdrop-blur-md border-b border-slate-800 px-4 lg:px-8 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-gradient-to-tr from-purple-600 to-pink-500 rounded-xl flex items-center justify-center shadow-lg shadow-purple-500/20">
            <span className="text-xl">⚡</span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold text-white tracking-tight">AI PR Reviewer</h1>
              <span className="bg-purple-500/10 text-purple-400 border border-purple-500/20 text-[10px] font-semibold px-2 py-0.5 rounded-full">
                PRO
              </span>
            </div>
            <p className="text-xs text-slate-400">Groq LPU • Qwen3-32B</p>
          </div>
        </div>

        {prDetails && (
          <div className="hidden md:flex items-center gap-4 bg-slate-950/50 px-4 py-1.5 rounded-full border border-slate-800 text-xs">
            <span className="text-slate-400 font-medium">
              {prDetails.pr.base.ref ? owner : parseGitHubUrl(prUrl)?.owner || owner}/
              {prDetails.pr.base.ref ? repo : parseGitHubUrl(prUrl)?.repo || repo}
            </span>
            <span className="text-purple-400 font-bold">#{prDetails.pr.number}</span>
            <div className="h-3 w-px bg-slate-800" />
            <span className="text-emerald-400 font-semibold">+{fileStats?.additions}</span>
            <span className="text-rose-400 font-semibold">-{fileStats?.deletions}</span>
          </div>
        )}

        <div className="flex items-center gap-3">
          {prDetails && (
            <button
              onClick={() => {
                setPrDetails(null);
                setReviewResult(null);
              }}
              className="text-xs font-medium text-slate-400 hover:text-white bg-slate-800/50 hover:bg-slate-800 px-3 py-1.5 rounded-lg transition-colors"
            >
              ← Switch PR
            </button>
          )}

          <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1">
            <span className="text-[10px] font-bold text-slate-500 uppercase">Model:</span>
            <select
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value as GroqModelId)}
              className="bg-transparent text-xs font-medium text-purple-300 focus:outline-none cursor-pointer"
            >
              <option value="qwen/qwen3-32b">Qwen3-32B</option>
              <option value="llama-3.3-70b-versatile">Llama-3.3-70B Versatile</option>
              <option value="llama-3.1-8b-instant">Llama-3.1-8B Instant</option>
              <option value="deepseek-r1-distill-llama-70b">DeepSeek R1 (Llama 70B)</option>
            </select>
          </div>

          <button
            onClick={() => setShowSettings(true)}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:shadow"
          >
            <svg className="w-4 h-4 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span>Settings</span>
          </button>
        </div>
      </header>

      {/* Global Alerts */}
      {successMessage && (
        <div className="bg-emerald-500/10 border-b border-emerald-500/20 text-emerald-400 text-sm px-4 py-2.5 text-center flex items-center justify-center gap-2 animate-fade-in">
          <span>✅</span>
          <span className="font-medium">{successMessage}</span>
        </div>
      )}

      {error && (
        <div className="bg-rose-500/10 border-b border-rose-500/20 text-rose-400 text-sm px-4 py-2.5 text-center flex items-center justify-center gap-2">
          <span>⚠️</span>
          <span className="font-medium">{error}</span>
        </div>
      )}

      {/* Main Workspace View */}
      <main className="flex-1 flex flex-col">
        {!prDetails ? (
          /* Landing & Configuration Dashboard */
          <div className="max-w-5xl mx-auto w-full px-4 py-10 flex-1 flex flex-col justify-center">
            <div className="text-center max-w-2xl mx-auto mb-10">
              <h2 className="text-3xl md:text-4xl font-extrabold text-white tracking-tight mb-4">
                Autonomous Code Reviews Delivered in <span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-400">Seconds</span>
              </h2>
              <p className="text-slate-400 text-sm md:text-base">
                Harness Alibaba&apos;s elite <span className="text-slate-200 font-semibold">Qwen3-32B</span> intelligence running on Groq&apos;s lightning-fast inference engine to instantly audit Pull Requests for security, performance, and architecture.
              </p>
            </div>

            {/* Main Interactive Workspace Controls */}
            <div className="bg-slate-900/60 backdrop-blur-xl rounded-2xl border border-slate-800/80 p-6 md:p-8 shadow-2xl relative">
              {/* Premium Sub-navigation switch */}
              <div className="flex border-b border-slate-800/80 mb-6 -mt-2">
                <button
                  onClick={() => setLandingTab('audit')}
                  className={cn(
                    "pb-3 text-xs font-bold transition-all relative flex-1 text-center flex items-center justify-center gap-2",
                    landingTab === 'audit'
                      ? "text-white border-b-2 border-purple-500"
                      : "text-slate-400 hover:text-slate-200"
                  )}
                >
                  <span>🚀</span>
                  <span>On-Demand Audit</span>
                </button>

                <button
                  onClick={() => {
                    setLandingTab('explorer');
                    if (repositories.length === 0 && githubToken) {
                      handleFetchRepositories();
                    }
                  }}
                  className={cn(
                    "pb-3 text-xs font-bold transition-all relative flex-1 text-center flex items-center justify-center gap-2",
                    landingTab === 'explorer'
                      ? "text-white border-b-2 border-purple-500"
                      : "text-slate-400 hover:text-slate-200"
                  )}
                >
                  <span>📂</span>
                  <span>GitHub Explorer</span>
                  {repositories.length > 0 && (
                    <span className="bg-purple-500/10 text-purple-400 border border-purple-500/20 text-[9px] px-1.5 py-0.5 rounded-full font-mono">
                      {repositories.length}
                    </span>
                  )}
                </button>

                <button
                  onClick={() => setLandingTab('webhooks')}
                  className={cn(
                    "pb-3 text-xs font-bold transition-all relative flex-1 text-center flex items-center justify-center gap-2",
                    landingTab === 'webhooks'
                      ? "text-white border-b-2 border-purple-500"
                      : "text-slate-400 hover:text-slate-200"
                  )}
                >
                  <span>🔌</span>
                  <span>Webhook Automations</span>
                  {detectedEvents.length > 0 && (
                    <span className="bg-pink-500 text-white text-[9px] px-1.5 py-0.5 rounded-full font-bold animate-bounce">
                      {detectedEvents.length}
                    </span>
                  )}
                </button>
              </div>

              {/* Sub-Tab 1: On-Demand Link / Manual Audit */}
              {landingTab === 'audit' && (
                <>
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Input Mode:</span>
                      <div className="inline-flex bg-slate-950 p-1 rounded-lg border border-slate-800">
                        <button
                          onClick={() => setInputMode('url')}
                          className={cn(
                            "px-3 py-1 rounded-md text-xs font-medium transition-all",
                            inputMode === 'url' ? "bg-slate-800 text-white shadow" : "text-slate-400 hover:text-slate-200"
                          )}
                        >
                          PR Link
                        </button>
                        <button
                          onClick={() => setInputMode('manual')}
                          className={cn(
                            "px-3 py-1 rounded-md text-xs font-medium transition-all",
                            inputMode === 'manual' ? "bg-slate-800 text-white shadow" : "text-slate-400 hover:text-slate-200"
                          )}
                        >
                          Manual Fields
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Profile:</span>
                      <select
                        value={reviewProfile}
                        onChange={(e) => setReviewProfile(e.target.value as ReviewProfile)}
                        className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1 text-xs font-medium text-purple-300 focus:outline-none focus:border-purple-500"
                      >
                        <option value="comprehensive">🌟 Comprehensive Audit</option>
                        <option value="security">🔒 Security Focus</option>
                        <option value="performance">⚡ Performance Optimization</option>
                        <option value="refactoring">🧹 Refactoring & Cleanliness</option>
                      </select>
                    </div>
                  </div>

                  {inputMode === 'url' ? (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-400 mb-1.5">
                          GitHub Pull Request URL
                        </label>
                        <input
                          type="text"
                          value={prUrl}
                          onChange={(e) => handleUrlChange(e.target.value)}
                          placeholder="https://github.com/facebook/react/pull/28900"
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500 transition-all"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-400 mb-1.5">Owner / Org</label>
                        <input
                          type="text"
                          value={owner}
                          onChange={(e) => setOwner(e.target.value)}
                          placeholder="facebook"
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500 transition-all"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-400 mb-1.5">Repository</label>
                        <input
                          type="text"
                          value={repo}
                          onChange={(e) => setRepo(e.target.value)}
                          placeholder="react"
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500 transition-all"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-400 mb-1.5">PR Number</label>
                        <input
                          type="number"
                          value={prNumber}
                          onChange={(e) => setPrNumber(e.target.value)}
                          placeholder="28900"
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500 transition-all"
                        />
                      </div>
                    </div>
                  )}

                  <div className="mt-4 pt-4 border-t border-slate-800/60">
                    <label className="block text-xs font-medium text-slate-400 mb-1.5 flex items-center justify-between">
                      <span>Custom Coding Guidelines & Context</span>
                      <span className="text-[10px] text-slate-500">Optional</span>
                    </label>
                    <textarea
                      value={customGuidelines}
                      onChange={(e) => setCustomGuidelines(e.target.value)}
                      placeholder="e.g., Always demand strict TypeScript typing. Ensure all database interactions utilize the custom safeQuery wrapper. Discourage default exports."
                      rows={2}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500 transition-all"
                    />
                  </div>

                  <div className="mt-6">
                    <button
                      id="review-trigger-btn"
                      onClick={handleReview}
                      disabled={isLoading || (inputMode === 'url' ? !prUrl : !owner || !repo || !prNumber)}
                      className={cn(
                        "w-full py-3.5 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2",
                        isLoading
                          ? "bg-slate-800 text-slate-500 cursor-not-allowed"
                          : "bg-gradient-to-r from-purple-600 via-purple-500 to-pink-500 text-white hover:opacity-95 shadow-lg shadow-purple-500/25"
                      )}
                    >
                      {isLoading ? (
                        <>
                          <svg className="animate-spin h-4 w-4 text-purple-400" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                          <span>{loadingStep || 'Analyzing with Groq LPU...'}</span>
                        </>
                      ) : (
                        <>
                          <span>🚀</span>
                          <span>Commence Autonomous Review</span>
                        </>
                      )}
                    </button>
                  </div>
                </>
              )}

              {/* Sub-Tab 2: Live GitHub Explorer */}
              {landingTab === 'explorer' && (
                <div className="space-y-6">
                  {!githubToken ? (
                    <div className="text-center py-12 border border-slate-800/80 rounded-xl bg-slate-950/50 px-6">
                      <span className="text-4xl block mb-3">🔑</span>
                      <h3 className="text-sm font-bold text-white mb-1.5">Personal Access Token Required</h3>
                      <p className="text-xs text-slate-400 max-w-md mx-auto mb-6 leading-relaxed">
                        To natively browse your active GitHub repositories and view live open Pull Requests directly within this workspace, please configure your private GitHub access token.
                      </p>
                      <button
                        onClick={() => setShowSettings(true)}
                        className="bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold px-4 py-2 rounded-lg transition-colors shadow"
                      >
                        Configure Access Token
                      </button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                      {/* Repositories Explorer List */}
                      <div className="md:col-span-1 border-r border-slate-800/80 pr-6 flex flex-col h-[420px]">
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                            Repositories
                          </span>
                          <button
                            onClick={handleFetchRepositories}
                            className="text-purple-400 hover:text-purple-300 text-xs font-medium flex items-center gap-1"
                          >
                            <span>🔄</span>
                            <span>Refresh</span>
                          </button>
                        </div>

                        <input
                          type="text"
                          value={repoSearch}
                          onChange={(e) => setRepoSearch(e.target.value)}
                          placeholder="Filter repositories..."
                          className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-purple-500 mb-3"
                        />

                        <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
                          {isLoadingRepos ? (
                            <div className="flex items-center justify-center py-12 text-slate-500 text-xs gap-2">
                              <span className="animate-spin">⏳</span> Loading repositories...
                            </div>
                          ) : repositories.length === 0 ? (
                            <div className="text-center py-8 text-slate-600 text-xs">
                              No repositories fetched. Click refresh to query GitHub API.
                            </div>
                          ) : (
                            repositories
                              .filter(r => r.name.toLowerCase().includes(repoSearch.toLowerCase()) || r.owner.login.toLowerCase().includes(repoSearch.toLowerCase()))
                              .map(repoObj => {
                                const isSelected = selectedRepoForPRs?.id === repoObj.id;
                                const prCount = repoPRCounts[repoObj.id];
                                
                                return (
                                  <button
                                    key={repoObj.id}
                                    onClick={() => handleSelectRepo(repoObj)}
                                    className={cn(
                                      "w-full text-left p-2.5 rounded-lg transition-all flex items-center justify-between group gap-2",
                                      isSelected 
                                        ? "bg-purple-600 text-white font-medium shadow" 
                                        : "bg-slate-950 hover:bg-slate-900 text-slate-300 border border-slate-850"
                                    )}
                                  >
                                    <div className="overflow-hidden flex-1">
                                      <div className="text-xs truncate font-mono">
                                        {repoObj.name}
                                      </div>
                                      <div className={cn(
                                        "text-[9px] truncate", 
                                        isSelected ? "text-purple-200" : "text-slate-500"
                                      )}>
                                        {repoObj.owner.login}
                                      </div>
                                    </div>

                                    <div className="flex items-center gap-1 shrink-0">
                                      {prCount && prCount > 0 ? (
                                        <span className={cn(
                                          "text-[10px] px-1.5 py-0.2 rounded-full font-bold",
                                          isSelected ? "bg-white text-purple-700" : "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                                        )}>
                                          {prCount}
                                        </span>
                                      ) : null}
                                      
                                      {repoObj.private ? (
                                        <span className="text-[9px] bg-slate-900 text-slate-400 px-1 rounded border border-slate-800">Priv</span>
                                      ) : (
                                        <span className="text-[9px] bg-emerald-950/50 text-emerald-400 px-1 rounded">Pub</span>
                                      )}
                                    </div>
                                  </button>
                                );
                              })
                          )}
                        </div>
                      </div>

                      {/* Pull Requests Viewer */}
                      <div className="md:col-span-2 flex flex-col h-[420px]">
                        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 block">
                          {selectedRepoForPRs ? `Open Pull Requests • ${selectedRepoForPRs.name}` : 'Select a Repository'}
                        </span>

                        <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
                          {!selectedRepoForPRs ? (
                            <div className="flex items-center justify-center h-full text-slate-600 text-xs border border-dashed border-slate-800 rounded-xl">
                              👈 Select a repository from the left panel to list its live Open Pull Requests.
                            </div>
                          ) : isLoadingPRs ? (
                            <div className="flex items-center justify-center h-full text-slate-500 text-xs gap-2">
                              <span className="animate-spin">⏳</span> Querying GitHub for active pull requests...
                            </div>
                          ) : repoPullRequests.length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-full text-slate-600 text-xs border border-dashed border-slate-800 rounded-xl p-6 text-center">
                              <span>✨</span>
                              <p className="mt-1">No open pull requests found for <strong className="text-slate-400">{selectedRepoForPRs.name}</strong>.</p>
                              <span className="text-[10px] text-slate-600 mt-0.5">All branches are fully merged or active PRs are closed!</span>
                            </div>
                          ) : (
                            repoPullRequests.map(prObj => (
                              <div
                                key={prObj.number}
                                className="bg-slate-950 border border-slate-850 hover:border-purple-500/50 rounded-xl p-3.5 transition-all flex flex-col justify-between"
                              >
                                <div>
                                  <div className="flex items-center justify-between gap-2 mb-1">
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs font-mono font-bold text-purple-400">
                                        #{prObj.number}
                                      </span>
                                      <span className="text-[9px] bg-emerald-950 text-emerald-400 border border-emerald-800/40 px-1.5 py-0.5 rounded font-semibold uppercase">
                                        {prObj.state}
                                      </span>
                                      {prObj.draft && (
                                        <span className="text-[9px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded font-semibold uppercase">
                                          Draft
                                        </span>
                                      )}
                                    </div>

                                    <span className="text-[10px] text-slate-500">
                                      {new Date(prObj.created_at).toLocaleDateString()}
                                    </span>
                                  </div>

                                  <h4 className="text-xs font-bold text-white hover:text-purple-300 transition-colors line-clamp-1">
                                    {prObj.title}
                                  </h4>

                                  <div className="flex items-center gap-1 text-[10px] text-slate-400 mt-1.5">
                                    <span>by</span>
                                    <img src={prObj.user.avatar_url} alt={prObj.user.login} className="w-3.5 h-3.5 rounded-full" />
                                    <span className="text-slate-300 font-medium">{prObj.user.login}</span>
                                    <span className="mx-1 text-slate-700">•</span>
                                    <span className="font-mono text-slate-500 truncate max-w-[150px]">
                                      {prObj.head.ref} → {prObj.base.ref}
                                    </span>
                                  </div>
                                </div>

                                <div className="mt-3 pt-2 border-t border-slate-900 flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    <select
                                      value={reviewProfile}
                                      onChange={(e) => setReviewProfile(e.target.value as ReviewProfile)}
                                      className="bg-slate-900 text-[10px] text-purple-300 border border-slate-800 rounded px-1.5 py-0.5 focus:outline-none"
                                    >
                                      <option value="comprehensive">🌟 General</option>
                                      <option value="security">🔒 Security</option>
                                      <option value="performance">⚡ Perf</option>
                                      <option value="refactoring">🧹 Clean</option>
                                    </select>
                                  </div>

                                  <button
                                    onClick={() => handleSelectExplorerPR(prObj, selectedRepoForPRs)}
                                    className="bg-purple-600 hover:bg-purple-500 text-white text-[11px] font-bold px-3 py-1 rounded-md transition-all shadow flex items-center gap-1"
                                  >
                                    <span>🤖</span>
                                    <span>Audit with AI</span>
                                  </button>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Sub-Tab 3: Webhook Automation & Event Engine */}
              {landingTab === 'webhooks' && (
                <div className="space-y-6">
                  <div className="bg-slate-950 border border-slate-800 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-base">🔌</span>
                        <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                          Live Background Webhook Polling
                        </h3>
                        <span className={cn(
                          "text-[9px] font-bold px-2 py-0.5 rounded-full",
                          isPollingEnabled 
                            ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                            : "bg-slate-800 text-slate-400"
                        )}>
                          {isPollingEnabled ? 'ACTIVE MONITORING' : 'PAUSED'}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-1 max-w-xl leading-relaxed">
                        Emulates real-time GitHub repository webhooks by polling the API for newly opened or recently synchronized Pull Requests inside your top active repositories.
                      </p>
                    </div>

                    <button
                      onClick={toggleWebhookPolling}
                      className={cn(
                        "px-4 py-2 rounded-xl text-xs font-bold transition-all shrink-0 shadow",
                        isPollingEnabled
                          ? "bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20"
                          : "bg-emerald-600 hover:bg-emerald-500 text-white"
                      )}
                    >
                      {isPollingEnabled ? 'Pause Live Listener' : 'Activate Webhook Engine'}
                    </button>
                  </div>

                  {/* Real-time event monitor display */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                        <span>📡</span>
                        <span>Detected Webhook Events</span>
                      </span>
                      {lastPollTime && (
                        <span className="text-[10px] text-slate-500">
                          Last sync: {lastPollTime.toLocaleTimeString()}
                        </span>
                      )}
                    </div>

                    <div className="bg-slate-950 border border-slate-850 rounded-xl p-4 min-h-[220px] max-h-[300px] overflow-y-auto space-y-2">
                      {!isPollingEnabled ? (
                        <div className="flex flex-col items-center justify-center py-12 text-slate-600 text-xs text-center">
                          <span className="text-2xl mb-2">⏸️</span>
                          <p>The Live Webhook engine is currently paused.</p>
                          <span className="text-[10px] text-slate-600 mt-0.5">Click &quot;Activate Webhook Engine&quot; above to start background polling.</span>
                        </div>
                      ) : detectedEvents.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-slate-500 text-xs text-center">
                          <span className="animate-spin text-lg mb-2">⚡</span>
                          <p className="text-purple-300 font-medium">Actively listening for GitHub repository events...</p>
                          <span className="text-[10px] text-slate-600 mt-1 max-w-md">
                            When a Pull Request is opened or synchronized in your active repositories, the real-time event will be captured and displayed below!
                          </span>
                        </div>
                      ) : (
                        detectedEvents.map(evt => (
                          <div 
                            key={evt.id}
                            className="bg-slate-900 border border-slate-800 rounded-lg p-3 flex items-center justify-between text-xs animate-fade-in"
                          >
                            <div className="flex items-center gap-3">
                              <span className={cn(
                                "w-2 h-2 rounded-full",
                                evt.type === 'opened' ? "bg-emerald-400 animate-pulse" : "bg-blue-400"
                              )} />
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="font-mono font-bold text-purple-400">
                                    {evt.repoFullName}#{evt.prNumber}
                                  </span>
                                  <span className="text-[9px] bg-slate-800 text-slate-300 px-1 rounded font-semibold uppercase">
                                    {evt.type}
                                  </span>
                                </div>
                                <p className="text-slate-200 font-medium mt-0.5">
                                  {evt.title}
                                </p>
                                <span className="text-[9px] text-slate-500">
                                  Triggered by {evt.author} • {new Date(evt.timestamp).toLocaleTimeString()}
                                </span>
                              </div>
                            </div>

                            <button
                              onClick={() => {
                                const [ownerName, repoName] = evt.repoFullName.split('/');
                                setOwner(ownerName);
                                setRepo(repoName);
                                setPrNumber(evt.prNumber.toString());
                                setInputMode('manual');
                                setLandingTab('audit');
                                
                                setTimeout(() => {
                                  const reviewBtn = document.getElementById('review-trigger-btn');
                                  if (reviewBtn) reviewBtn.click();
                                }, 100);
                              }}
                              className="bg-purple-600 hover:bg-purple-500 text-white text-[10px] font-bold px-2.5 py-1.5 rounded transition-all shadow shrink-0"
                            >
                              Audit Event
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Integration Documentation */}
                  <div className="border-t border-slate-800/80 pt-4">
                    <h4 className="text-xs font-bold text-slate-300 mb-1">
                      Native GitHub Webhook Integration Reference
                    </h4>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      To receive instant delivery from GitHub Servers bypassing background API polling, navigate to your GitHub Repository &gt; <strong>Settings</strong> &gt; <strong>Webhooks</strong>. Set the Payload URL to your public gateway and choose Content type <code>application/json</code> subscribing to <strong>Pull request</strong> events.
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* History Section */}
            {reviewHistory.length > 0 && (
              <div className="mt-12">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                    <span>🕒</span>
                    <span>Recent Audits</span>
                  </h3>
                  <button 
                    onClick={() => {
                      localStorage.removeItem('review_history');
                      setReviewHistory([]);
                    }}
                    className="text-[11px] text-slate-500 hover:text-slate-400"
                  >
                    Clear History
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {reviewHistory.map((item) => (
                    <div
                      key={item.id}
                      onClick={() => handleLoadHistory(item)}
                      className="bg-slate-900/40 hover:bg-slate-900 border border-slate-800/80 hover:border-slate-700 p-3.5 rounded-xl cursor-pointer transition-all flex flex-col justify-between group"
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-xs font-semibold text-purple-400 truncate">
                            {item.owner}/{item.repo}
                          </span>
                          <span className="text-[10px] bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded font-mono">
                            #{item.prNumber}
                          </span>
                        </div>
                        <p className="text-xs text-slate-200 font-medium line-clamp-1 group-hover:text-purple-300 transition-colors">
                          {item.title}
                        </p>
                      </div>

                      <div className="flex items-center justify-between mt-3 pt-2 border-t border-slate-800/40 text-[10px]">
                        <span className={cn(
                          "font-bold uppercase",
                          item.assessment === 'approve' && "text-emerald-400",
                          item.assessment === 'request_changes' && "text-rose-400",
                          item.assessment === 'comment' && "text-blue-400"
                        )}>
                          {item.assessment.replace('_', ' ')}
                        </span>
                        <span className="text-slate-500">
                          {item.issuesCount} findings
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Main Review & Analysis Interface */
          <div className="flex-1 flex flex-col">
            {/* Sub-Header Tabs */}
            <div className="bg-slate-900 border-b border-slate-800 px-4 lg:px-8 flex items-center justify-between">
              <div className="flex gap-1 overflow-x-auto">
                <button
                  onClick={() => setActiveTab('review')}
                  className={cn(
                    "px-4 py-3 text-xs font-bold border-b-2 transition-all whitespace-nowrap flex items-center gap-2",
                    activeTab === 'review'
                      ? "border-purple-500 text-purple-400 bg-purple-500/5"
                      : "border-transparent text-slate-400 hover:text-slate-200"
                  )}
                >
                  <span>📋</span>
                  <span>AI Findings Dashboard</span>
                  {reviewResult && (
                    <span className="bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded-full text-[10px]">
                      {reviewResult.issues.filter(i => i.included !== false).length}
                    </span>
                  )}
                </button>

                <button
                  onClick={() => setActiveTab('files')}
                  className={cn(
                    "px-4 py-3 text-xs font-bold border-b-2 transition-all whitespace-nowrap flex items-center gap-2",
                    activeTab === 'files'
                      ? "border-purple-500 text-purple-400 bg-purple-500/5"
                      : "border-transparent text-slate-400 hover:text-slate-200"
                  )}
                >
                  <span>📁</span>
                  <span>File Diffs & Content</span>
                  <span className="bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded-full text-[10px]">
                    {prDetails.files.length}
                  </span>
                </button>

                <button
                  onClick={() => setActiveTab('chat')}
                  className={cn(
                    "px-4 py-3 text-xs font-bold border-b-2 transition-all whitespace-nowrap flex items-center gap-2",
                    activeTab === 'chat'
                      ? "border-purple-500 text-purple-400 bg-purple-500/5"
                      : "border-transparent text-slate-400 hover:text-slate-200"
                  )}
                >
                  <span>💬</span>
                  <span>Chat with PR</span>
                  {chatHistory.length > 0 && (
                    <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
                  )}
                </button>

                <button
                  onClick={() => setActiveTab('overview')}
                  className={cn(
                    "px-4 py-3 text-xs font-bold border-b-2 transition-all whitespace-nowrap flex items-center gap-2",
                    activeTab === 'overview'
                      ? "border-purple-500 text-purple-400 bg-purple-500/5"
                      : "border-transparent text-slate-400 hover:text-slate-200"
                  )}
                >
                  <span>ℹ️</span>
                  <span>PR Metadata</span>
                </button>
              </div>

              {/* Direct Post Trigger */}
              {activeTab === 'review' && reviewResult && (
                <div className="py-1.5">
                  <button
                    onClick={handlePostToGitHub}
                    disabled={isPosting}
                    className="bg-purple-600 hover:bg-purple-500 text-white px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all shadow flex items-center gap-1.5"
                  >
                    {isPosting ? (
                      <>
                        <span className="animate-spin">⏳</span>
                        <span>Publishing...</span>
                      </>
                    ) : (
                      <>
                        <span>📤</span>
                        <span>Post Review to GitHub</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>

            {/* Tab Contents */}
            <div className="flex-1 flex flex-col relative">
              {/* TAB 1: AI Findings Dashboard */}
              {activeTab === 'review' && (
                <div className="flex-1 p-4 lg:p-8 max-w-7xl mx-auto w-full space-y-6">
                  {reviewResult ? (
                    <>
                      {/* Overall Status Box */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
                          <div className="flex items-center gap-4">
                            <div className={cn(
                              "w-12 h-12 rounded-xl flex items-center justify-center text-2xl font-bold shrink-0",
                              (reviewResult.overallAssessment === 'approve' || reviewResult.overallAssessment === 'good_to_go') && "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20",
                              reviewResult.overallAssessment === 'request_changes' && "bg-rose-500/10 text-rose-400 border border-rose-500/20",
                              reviewResult.overallAssessment === 'comment' && "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                            )}>
                              {reviewResult.overallAssessment === 'approve' && '✅'}
                              {reviewResult.overallAssessment === 'good_to_go' && '✔️'}
                              {reviewResult.overallAssessment === 'request_changes' && '❌'}
                              {reviewResult.overallAssessment === 'comment' && '💬'}
                            </div>
                            <div className="overflow-hidden">
                              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                                Recommendation
                              </span>
                              <h3 className="text-base font-bold text-white capitalize truncate">
                                {reviewResult.overallAssessment === 'good_to_go' ? 'Good to go' : reviewResult.overallAssessment.replace('_', ' ')}
                              </h3>
                            </div>
                          </div>

                          {reviewResult.overallAssessment !== 'good_to_go' && (
                            <button
                              onClick={() => {
                                setReviewResult(prev => {
                                  if (!prev) return prev;
                                  return { ...prev, overallAssessment: 'good_to_go' };
                                });
                                setSuccessMessage('Recommendation directly overridden to "✔️ Good to go"!');
                                setTimeout(() => setSuccessMessage(null), 2500);
                              }}
                              className="mt-3 w-full bg-slate-950 hover:bg-slate-800 text-[11px] font-bold text-emerald-400 border border-emerald-500/20 hover:border-emerald-500/40 py-1.5 rounded-lg transition-all flex items-center justify-center gap-1"
                              title="Override status if findings are non-critical"
                            >
                              <span>✔️</span>
                              <span>Override to &quot;Good to go&quot;</span>
                            </button>
                          )}
                        </div>

                        <div className="md:col-span-2 bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-center">
                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 block">
                            Executive Summary
                          </span>
                          <p className="text-xs text-slate-200 leading-relaxed overflow-y-auto max-h-24 pr-1">
                            {reviewResult.summary}
                          </p>
                        </div>
                      </div>

                      {/* Issues Management Header */}
                      <div className="flex items-center justify-between pt-2">
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-bold text-white">
                            Curated Feedback Items
                          </h3>
                          <span className="text-xs text-slate-400">
                            ({reviewResult.issues.filter(i => i.included !== false).length} selected)
                          </span>
                        </div>

                        <button
                          onClick={() => {
                            // Populate custom file dropdown with available PR files
                            if (prDetails.files.length > 0) {
                              setCustomFile(prDetails.files[0].filename);
                            }
                            setShowCustomModal(true);
                          }}
                          className="bg-slate-800 hover:bg-slate-700 text-purple-300 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 border border-slate-700"
                        >
                          <span>➕</span>
                          <span>Add Custom Comment</span>
                        </button>
                      </div>

                      {/* Findings Grid */}
                      <div className="space-y-3">
                        {reviewResult.issues.length === 0 ? (
                          <div className="bg-slate-900/50 border border-slate-800/80 rounded-xl p-8 text-center">
                            <p className="text-sm text-slate-400">No critical code issues were found! Excellent work.</p>
                          </div>
                        ) : (
                          reviewResult.issues.map((issue) => {
                            const isIncluded = issue.included !== false;
                            
                            const typeStyles: Record<string, { bg: string; border: string; text: string; icon: string }> = {
                              error: { bg: 'bg-rose-950/20', border: 'border-rose-500/30', text: 'text-rose-400', icon: '🔴' },
                              warning: { bg: 'bg-amber-950/20', border: 'border-amber-500/30', text: 'text-amber-400', icon: '🟡' },
                              info: { bg: 'bg-blue-950/20', border: 'border-blue-500/30', text: 'text-blue-400', icon: '🔵' },
                              suggestion: { bg: 'bg-purple-950/20', border: 'border-purple-500/30', text: 'text-purple-400', icon: '💡' },
                            };

                            const style = typeStyles[issue.type] || typeStyles.info;

                            return (
                              <div
                                key={issue.id}
                                className={cn(
                                  "rounded-xl border p-4 transition-all flex gap-3.5",
                                  style.bg,
                                  isIncluded ? style.border : "border-slate-800/40 opacity-40 bg-slate-950"
                                )}
                              >
                                {/* Checkbox Toggle */}
                                <div className="pt-0.5">
                                  <input
                                    type="checkbox"
                                    checked={isIncluded}
                                    onChange={() => toggleIssueInclusion(issue.id)}
                                    className="w-4 h-4 rounded border-slate-700 text-purple-600 focus:ring-purple-500 bg-slate-950 cursor-pointer"
                                    title={isIncluded ? "Include in GitHub Post" : "Excluded from GitHub Post"}
                                  />
                                </div>

                                <div className="flex-1">
                                  <div className="flex items-center justify-between gap-2 mb-1.5">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className={cn("text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-slate-950 border border-slate-800", style.text)}>
                                        {style.icon} {issue.type}
                                      </span>

                                      <span className="text-xs font-mono text-slate-300 bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                                        {issue.file}
                                      </span>

                                      {issue.line && (
                                        <span className="text-xs font-mono text-purple-400 bg-purple-950/30 px-1.5 py-0.5 rounded border border-purple-800/40">
                                          Line {issue.line}
                                        </span>
                                      )}

                                      {issue.isCustom && (
                                        <span className="text-[10px] bg-pink-500/10 text-pink-400 border border-pink-500/20 px-1.5 py-0.5 rounded font-semibold">
                                          USER COMMENT
                                        </span>
                                      )}
                                    </div>

                                    <button
                                      onClick={() => deleteIssue(issue.id)}
                                      className="text-slate-500 hover:text-rose-400 text-xs transition-colors p-1"
                                      title="Delete comment"
                                    >
                                      ✕
                                    </button>
                                  </div>

                                  <p className={cn(
                                    "text-xs leading-relaxed mt-1",
                                    isIncluded ? "text-slate-200" : "text-slate-500 line-through"
                                  )}>
                                    {issue.message}
                                  </p>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>

                      {/* General Suggestions */}
                      {reviewResult.suggestions && reviewResult.suggestions.length > 0 && (
                        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mt-6">
                          <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                            <span>💡</span>
                            <span>High-Level Strategic Recommendations</span>
                          </h4>
                          <ul className="space-y-2">
                            {reviewResult.suggestions.map((s, idx) => (
                              <li key={idx} className="text-xs text-slate-300 flex items-start gap-2">
                                <span className="text-purple-400 font-bold">•</span>
                                <span className="flex-1">{s}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="text-center py-20">
                      <p className="text-slate-500 text-sm">No review data loaded. Please commence an audit first.</p>
                    </div>
                  )}
                </div>
              )}

              {/* TAB 2: File Diffs & Content Explorer */}
              {activeTab === 'files' && (
                <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
                  {/* Sidebar File List */}
                  <div className="w-full md:w-72 bg-slate-900 border-r border-slate-800 flex flex-col shrink-0">
                    <div className="p-3 border-b border-slate-800 text-xs font-bold text-slate-400 uppercase tracking-wider">
                      Changed Files ({prDetails.files.length})
                    </div>
                    <div className="flex-1 overflow-y-auto divide-y divide-slate-800/50">
                      {prDetails.files.map((file) => {
                        const isSelected = selectedFile?.filename === file.filename;
                        return (
                          <button
                            key={file.filename}
                            onClick={() => setSelectedFile(file)}
                            className={cn(
                              "w-full p-3 text-left transition-colors flex flex-col gap-1 text-xs",
                              isSelected ? "bg-slate-800 text-white" : "hover:bg-slate-800/50 text-slate-300"
                            )}
                          >
                            <div className="font-mono truncate font-medium">
                              {file.filename}
                            </div>
                            <div className="flex items-center gap-2 text-[10px]">
                              <span className={cn(
                                "px-1 rounded font-semibold",
                                file.status === 'added' && "bg-emerald-950 text-emerald-400",
                                file.status === 'removed' && "bg-rose-950 text-rose-400",
                                file.status === 'modified' && "bg-blue-950 text-blue-400",
                                file.status === 'renamed' && "bg-purple-950 text-purple-400"
                              )}>
                                {file.status}
                              </span>
                              <span className="text-emerald-400">+{file.additions}</span>
                              <span className="text-rose-400">-{file.deletions}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Diff / Code Viewer */}
                  <div className="flex-1 bg-slate-950 flex flex-col overflow-hidden">
                    {selectedFile ? (
                      <>
                        <div className="bg-slate-900 px-4 py-2 border-b border-slate-800 flex items-center justify-between text-xs">
                          <span className="font-mono font-bold text-slate-200 truncate">
                            {selectedFile.filename}
                          </span>
                          <span className="text-slate-400 shrink-0">
                            {selectedFile.changes} total changes
                          </span>
                        </div>

                        <div className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed">
                          {!selectedFile.patch ? (
                            <div className="text-center py-12 text-slate-600">
                              No diff patch accessible for this file (potentially binary or extremely large).
                            </div>
                          ) : (
                            <div className="space-y-0.5">
                              {selectedFile.patch.split('\n').map((line, idx) => {
                                let bgStyle = "text-slate-300";
                                if (line.startsWith('+')) {
                                  bgStyle = "bg-emerald-950/40 text-emerald-300 font-medium";
                                } else if (line.startsWith('-')) {
                                  bgStyle = "bg-rose-950/40 text-rose-300 line-through opacity-80";
                                } else if (line.startsWith('@@')) {
                                  bgStyle = "bg-purple-950/30 text-purple-400 font-bold my-2 py-0.5 px-2 rounded block";
                                }

                                return (
                                  <div key={idx} className={cn("px-2 py-0.5 rounded whitespace-pre", bgStyle)}>
                                    {line}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="flex-1 flex items-center justify-center text-slate-600 text-xs">
                        Select a file from the sidebar to inspect its git diff content.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 3: Chat with PR Agent */}
              {activeTab === 'chat' && (
                <div className="flex-1 flex flex-col max-w-4xl mx-auto w-full p-4 lg:p-6 overflow-hidden">
                  {/* Chat History Panel */}
                  <div className="flex-1 overflow-y-auto space-y-4 pr-2">
                    {chatHistory.length === 0 ? (
                      <div className="text-center py-16 border border-slate-800/60 rounded-2xl bg-slate-900/30 p-8">
                        <span className="text-4xl block mb-3">💬</span>
                        <h4 className="text-sm font-bold text-white mb-1">Conversational PR Assistant</h4>
                        <p className="text-xs text-slate-400 max-w-md mx-auto">
                          Ask Groq Qwen3-32B absolutely anything regarding this specific Pull Request. The assistant possesses complete visibility over all modified files, diff patches, and descriptions.
                        </p>
                        <div className="mt-6 flex flex-wrap justify-center gap-2">
                          <button
                            onClick={() => setCurrentChatMessage("Can you summarize the core architectural changes in this PR?")}
                            className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] px-3 py-1.5 rounded-lg transition-colors"
                          >
                            Summarize Architecture
                          </button>
                          <button
                            onClick={() => setCurrentChatMessage("Are there any subtle backwards-compatibility breaking changes?")}
                            className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] px-3 py-1.5 rounded-lg transition-colors"
                          >
                            Check Compatibility
                          </button>
                          <button
                            onClick={() => setCurrentChatMessage("Identify any potential memory leaks or unoptimized loops.")}
                            className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] px-3 py-1.5 rounded-lg transition-colors"
                          >
                            Audit Memory Leaks
                          </button>
                        </div>
                      </div>
                    ) : (
                      chatHistory.map((msg) => (
                        <div
                          key={msg.id}
                          className={cn(
                            "flex gap-3 max-w-[85%] rounded-2xl p-4 text-xs leading-relaxed",
                            msg.role === 'user' 
                              ? "ml-auto bg-purple-600 text-white rounded-br-none" 
                              : "bg-slate-900 border border-slate-800 text-slate-200 rounded-bl-none"
                          )}
                        >
                          <span className="text-base shrink-0 pt-0.5">
                            {msg.role === 'user' ? '👤' : '🤖'}
                          </span>
                          <div className="space-y-2 flex-1 overflow-hidden">
                            <div className="flex items-center justify-between text-[9px] text-slate-400 border-b border-slate-800/40 pb-1">
                              <span className="font-bold uppercase tracking-wider">
                                {msg.role === 'user' ? 'You' : 'Groq Qwen3-32B'}
                              </span>
                              <span>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                            </div>
                            <div className="whitespace-pre-wrap font-sans">
                              {msg.content}
                            </div>
                          </div>
                        </div>
                      ))
                    )}

                    {isChatting && (
                      <div className="flex gap-3 max-w-[85%] bg-slate-900 border border-slate-800 text-slate-200 rounded-2xl rounded-bl-none p-4 text-xs">
                        <span className="text-base shrink-0 animate-spin">⚡</span>
                        <div className="flex items-center gap-1 text-purple-400 font-medium">
                          <span>Qwen3-32B is evaluating code logic</span>
                          <span className="animate-pulse">...</span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Chat Form */}
                  <form onSubmit={handleSendMessage} className="mt-4 pt-2 border-t border-slate-800">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={currentChatMessage}
                        onChange={(e) => setCurrentChatMessage(e.target.value)}
                        placeholder="Ask a question about the code changes..."
                        className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-purple-500"
                      />
                      <button
                        type="submit"
                        disabled={isChatting || !currentChatMessage.trim()}
                        className="bg-purple-600 hover:bg-purple-500 disabled:bg-slate-800 disabled:text-slate-600 text-white px-5 py-3 rounded-xl text-xs font-bold transition-all shrink-0"
                      >
                        Send
                      </button>
                    </div>
                  </form>
                </div>
              )}

              {/* TAB 4: PR Overview Metadata */}
              {activeTab === 'overview' && (
                <div className="flex-1 p-4 lg:p-8 max-w-4xl mx-auto w-full space-y-6">
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
                    <div className="flex items-center gap-4 mb-4">
                      <img 
                        src={prDetails.pr.user.avatar_url} 
                        alt={prDetails.pr.user.login}
                        className="w-12 h-12 rounded-full border border-slate-700" 
                      />
                      <div>
                        <h3 className="text-base font-bold text-white">
                          {prDetails.pr.title}
                        </h3>
                        <p className="text-xs text-slate-400">
                          Opened by <span className="text-purple-400 font-medium">{prDetails.pr.user.login}</span> on {new Date(prDetails.pr.created_at).toLocaleDateString()}
                        </p>
                      </div>
                    </div>

                    <div className="mt-6 pt-4 border-t border-slate-800">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-2">
                        Original Pull Request Description
                      </span>
                      <div className="bg-slate-950 rounded-xl p-4 font-sans text-xs text-slate-300 whitespace-pre-wrap leading-relaxed max-h-96 overflow-y-auto">
                        {prDetails.pr.body || '*No description was provided for this pull request.*'}
                      </div>
                    </div>

                    <div className="mt-6 pt-4 border-t border-slate-800 flex items-center justify-between text-xs">
                      <span className="text-slate-400">
                        Status: <strong className="text-emerald-400 uppercase">{prDetails.pr.state}</strong>
                      </span>
                      <a
                        href={prDetails.pr.html_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-purple-400 hover:underline flex items-center gap-1"
                      >
                        <span>View directly on GitHub</span>
                        <span>↗</span>
                      </a>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* MODAL: Add Custom Comment */}
      {showCustomModal && prDetails && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6 w-full max-w-md shadow-2xl animate-scale-up">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <span>➕</span>
                <span>Append Custom Review Finding</span>
              </h3>
              <button 
                onClick={() => setShowCustomModal(false)}
                className="text-slate-500 hover:text-white"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleAddCustomComment} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Target File</label>
                <select
                  value={customFile}
                  onChange={(e) => setCustomFile(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-purple-500 font-mono"
                >
                  <option value="General">General / Cross-Cutting</option>
                  {prDetails.files.map(f => (
                    <option key={f.filename} value={f.filename}>{f.filename}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Issue Type</label>
                  <select
                    value={customType}
                    onChange={(e) => setCustomType(e.target.value as IssueType)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-purple-500"
                  >
                    <option value="error">🔴 Error</option>
                    <option value="warning">🟡 Warning</option>
                    <option value="info">🔵 Info</option>
                    <option value="suggestion">💡 Suggestion</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Line Number (Optional)</label>
                  <input
                    type="number"
                    value={customLine}
                    onChange={(e) => setCustomLine(e.target.value)}
                    placeholder="e.g. 42"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-purple-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Comment / Finding</label>
                <textarea
                  value={customMessage}
                  onChange={(e) => setCustomMessage(e.target.value)}
                  placeholder="Explain the specific logic issue, refactoring proposal, or custom validation requirement."
                  rows={3}
                  required
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-purple-500"
                />
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCustomModal(false)}
                  className="flex-1 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold transition-colors shadow"
                >
                  Add Finding
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: Settings */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6 w-full max-w-md shadow-2xl animate-scale-up">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <span>⚙️</span>
                <span>Workspace Configuration</span>
              </h3>
              <button
                onClick={() => setShowSettings(false)}
                className="text-slate-500 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Groq API Key <span className="text-purple-400">*</span>
                </label>
                <input
                  type="password"
                  value={groqApiKey}
                  onChange={(e) => setGroqApiKey(e.target.value)}
                  placeholder="gsk_..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-purple-500 font-mono"
                />
                <p className="mt-1 text-[10px] text-slate-500">
                  Obtain your instant inference access key via{' '}
                  <a
                    href="https://console.groq.com/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-purple-400 hover:underline"
                  >
                    console.groq.com
                  </a>
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  GitHub Personal Access Token (PAT)
                </label>
                <input
                  type="password"
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder="ghp_..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-purple-500 font-mono"
                />
                <p className="mt-1 text-[10px] text-slate-500">
                  Highly recommended to bypass strict API rate limits and directly publish feedback comments. Needs <code className="text-purple-400">repo</code> scope.
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Default Inference Model
                </label>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value as GroqModelId)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-purple-500"
                >
                  <option value="qwen/qwen3-32b">Qwen3-32B (Default)</option>
                  <option value="llama-3.3-70b-versatile">Llama-3.3-70B Versatile (Higher Token Limit)</option>
                  <option value="llama-3.1-8b-instant">Llama-3.1-8B Instant (Ultra Fast)</option>
                  <option value="deepseek-r1-distill-llama-70b">DeepSeek R1 (Llama 70B Reasoning)</option>
                </select>
                <p className="mt-1 text-[10px] text-slate-500">
                  If you encounter <code className="text-purple-400">413 Request too large</code> errors, switch to the Llama-3.3-70B Versatile tier.
                </p>
              </div>

              <div className="pt-2 border-t border-slate-800">
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Persistent Global Guidelines
                </label>
                <textarea
                  value={customGuidelines}
                  onChange={(e) => setCustomGuidelines(e.target.value)}
                  placeholder="Global rules injected into every review profile automatically."
                  rows={2}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-purple-500"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowSettings(false)}
                className="flex-1 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveSettings}
                className="flex-1 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold transition-colors shadow"
              >
                Save Configuration
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sleek Footer */}
      <footer className="bg-slate-950 border-t border-slate-900 py-3 px-4 text-center text-[10px] text-slate-600">
        AI PR Reviewer • Built with React 19, Vite & Groq API • Open Source
      </footer>
    </div>
  );
}

export default App;
