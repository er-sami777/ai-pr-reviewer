"""
🤖 AI PR Reviewer FastAPI Application
======================================
The main FastAPI service exposing:
- Health check endpoint
- GitHub webhook receiver (auto-triggered on PR events)
- Manual PR review trigger endpoint
"""

import logging
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, HTTPException, BackgroundTasks, Header
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings, load_coding_standards
from app.schemas import (
    ManualReviewRequest,
    ReviewResponse,
    HealthResponse,
    WebhookResponse,
)
from app.github_client import (
    fetch_full_pr_context,
    post_pr_review_comment,
    post_pr_issue_comment,
)
from app.ai_reviewer import review_pull_request, format_review_as_markdown
from app.webhook_security import verify_github_webhook_signature


# ===== Logging Setup =====
logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger("ai-pr-reviewer")


# ===== Lifespan Hook =====
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifecycle hook for startup and shutdown events."""
    logger.info("=" * 60)
    logger.info("🤖 AI PR Reviewer FastAPI Service Starting")
    logger.info("=" * 60)
    logger.info(f"Groq Model: {settings.GROQ_MODEL}")
    logger.info(f"Standards File: {settings.CODING_STANDARDS_PATH}")
    logger.info(f"Webhook Secret Configured: {bool(settings.GITHUB_WEBHOOK_SECRET)}")

    standards = load_coding_standards()
    if standards:
        logger.info(f"✅ Loaded coding standards ({len(standards)} chars)")
    else:
        logger.warning("⚠️  No coding standards loaded — operating with AI defaults only")

    logger.info("=" * 60)
    yield
    logger.info("🛑 AI PR Reviewer Service Shutting Down")


# ===== FastAPI App Initialization =====
app = FastAPI(
    title="AI PR Reviewer Agent",
    description="Autonomous first-level code review for GitHub Pull Requests, powered by Groq AI.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ===== Endpoints =====
@app.get("/", response_model=HealthResponse, tags=["System"])
async def health_check() -> HealthResponse:
    """Service health endpoint — returns current configuration state."""
    return HealthResponse(
        status="healthy",
        model=settings.GROQ_MODEL,
        standards_loaded=bool(load_coding_standards()),
    )


@app.get("/standards", tags=["System"])
async def get_coding_standards() -> dict[str, str]:
    """Return the currently loaded coding standards Markdown."""
    standards = load_coding_standards()
    return {
        "path": settings.CODING_STANDARDS_PATH,
        "content": standards or "(No standards file found)",
    }


@app.post("/review", response_model=ReviewResponse, tags=["Review"])
async def manual_review(request: ManualReviewRequest) -> ReviewResponse:
    """
    Manually trigger an AI review for a specific Pull Request.

    Useful for re-running reviews on demand or backfilling reviews on existing PRs.
    """
    logger.info(
        f"Manual review requested for {request.owner}/{request.repo}#{request.pr_number}"
    )

    try:
        pr_data, files_data = await fetch_full_pr_context(
            request.owner, request.repo, request.pr_number
        )
    except Exception as exc:
        logger.error(f"Failed to fetch PR context: {exc}")
        raise HTTPException(status_code=502, detail=f"GitHub API error: {exc}")

    try:
        review = await review_pull_request(
            pr_title=pr_data.get("title", ""),
            pr_description=pr_data.get("body", "") or "",
            files=files_data,
        )
    except Exception as exc:
        logger.error(f"AI review failed: {exc}")
        raise HTTPException(status_code=500, detail=f"AI inference error: {exc}")

    posted_url = None
    if request.auto_post:
        try:
            markdown_review = format_review_as_markdown(review, settings.GROQ_MODEL)

            # Try the formal review endpoint first
            try:
                posted = await post_pr_review_comment(
                    request.owner, request.repo, request.pr_number, markdown_review
                )
                posted_url = posted.get("html_url")
            except Exception:
                # Fallback to issue-style comment if formal review submission fails
                posted = await post_pr_issue_comment(
                    request.owner, request.repo, request.pr_number, markdown_review
                )
                posted_url = posted.get("html_url")

            logger.info(f"✅ Review posted: {posted_url}")
        except Exception as exc:
            logger.error(f"Failed to post review back to GitHub: {exc}")

    return ReviewResponse(
        summary=review.get("summary", ""),
        overallAssessment=review.get("overallAssessment", "comment"),
        issues=review.get("issues", []),
        suggestions=review.get("suggestions", []),
        was_truncated=review.get("was_truncated", False),
        posted_to_github=bool(posted_url),
        posted_comment_url=posted_url,
    )


@app.post("/webhook/github", response_model=WebhookResponse, tags=["Webhook"])
async def github_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    x_github_event: str | None = Header(default=None),
    x_hub_signature_256: str | None = Header(default=None),
) -> WebhookResponse:
    """
    Native GitHub webhook receiver.

    Subscribe to the `pull_request` events in your GitHub repository
    webhook settings — point the Payload URL to this endpoint.

    Automatically performs an AI review when PRs are opened, reopened, or synchronized.
    """
    payload_body = await request.body()

    # Verify HMAC signature for security
    if not verify_github_webhook_signature(payload_body, x_hub_signature_256):
        logger.warning("⚠️ Rejected webhook delivery — invalid signature")
        raise HTTPException(status_code=403, detail="Invalid webhook signature")

    # Only process pull_request events
    if x_github_event != "pull_request":
        return WebhookResponse(
            accepted=True,
            message=f"Ignored event type: {x_github_event}",
        )

    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    action = payload.get("action", "")
    pr_data = payload.get("pull_request", {})
    repo_data = payload.get("repository", {})

    # Only trigger reviews on these specific actions
    if action not in ("opened", "reopened", "synchronize"):
        return WebhookResponse(
            accepted=True,
            message=f"Ignored PR action: {action}",
            pr_number=pr_data.get("number"),
        )

    pr_number = pr_data.get("number")
    owner = repo_data.get("owner", {}).get("login")
    repo_name = repo_data.get("name")

    if not all((pr_number, owner, repo_name)):
        raise HTTPException(status_code=400, detail="Incomplete webhook payload")

    logger.info(
        f"🔔 Webhook received: {owner}/{repo_name}#{pr_number} (action: {action})"
    )

    # Schedule the review to run in the background so we return 200 immediately to GitHub
    background_tasks.add_task(
        _run_background_review, owner, repo_name, pr_number
    )

    return WebhookResponse(
        accepted=True,
        message=f"AI review queued for {owner}/{repo_name}#{pr_number}",
        pr_number=pr_number,
    )


async def _run_background_review(owner: str, repo: str, pr_number: int) -> None:
    """Background task: Perform the AI review and post results back to GitHub."""
    try:
        logger.info(f"⚡ Starting background review for {owner}/{repo}#{pr_number}")

        pr_data, files_data = await fetch_full_pr_context(owner, repo, pr_number)

        review = await review_pull_request(
            pr_title=pr_data.get("title", ""),
            pr_description=pr_data.get("body", "") or "",
            files=files_data,
        )

        markdown = format_review_as_markdown(review, settings.GROQ_MODEL)

        try:
            posted = await post_pr_review_comment(owner, repo, pr_number, markdown)
        except Exception:
            posted = await post_pr_issue_comment(owner, repo, pr_number, markdown)

        logger.info(
            f"✅ Background review completed and posted: {posted.get('html_url')}"
        )
    except Exception as exc:
        logger.exception(
            f"❌ Background review failed for {owner}/{repo}#{pr_number}: {exc}"
        )


# ===== Entry Point =====
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host=settings.HOST,
        port=settings.PORT,
        log_level=settings.LOG_LEVEL,
        reload=False,
    )
