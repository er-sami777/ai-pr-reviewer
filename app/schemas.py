"""
Pydantic Request & Response Schemas
====================================
Type-safe data models for all API endpoints exposed by the FastAPI service.
"""

from typing import Optional
from pydantic import BaseModel, Field


class ManualReviewRequest(BaseModel):
    """Request schema for the manual /review endpoint."""

    owner: str = Field(..., description="GitHub repository owner (user or org)", examples=["facebook"])
    repo: str = Field(..., description="GitHub repository name", examples=["react"])
    pr_number: int = Field(..., gt=0, description="Pull Request number", examples=[12345])
    auto_post: bool = Field(
        default=True,
        description="Automatically post the review back to the GitHub PR",
    )


class ReviewIssue(BaseModel):
    """A single AI-detected issue or recommendation."""
    type: str
    file: str
    line: Optional[int] = None
    message: str


class ReviewResponse(BaseModel):
    """Response schema for review endpoints."""

    summary: str
    overallAssessment: str
    issues: list[ReviewIssue]
    suggestions: list[str]
    was_truncated: bool = False
    posted_to_github: bool = False
    posted_comment_url: Optional[str] = None


class HealthResponse(BaseModel):
    """Service health check response."""
    status: str
    model: str
    standards_loaded: bool


class WebhookResponse(BaseModel):
    """Generic response for webhook acknowledgements."""
    accepted: bool
    message: str
    pr_number: Optional[int] = None
