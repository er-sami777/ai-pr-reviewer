"""
GitHub Webhook Signature Verification
=====================================
Securely validates that incoming webhook payloads are genuinely from GitHub
using HMAC-SHA256 signature comparison.
"""

import hmac
import hashlib

from app.config import settings


def verify_github_webhook_signature(
    payload_body: bytes,
    received_signature: str | None,
) -> bool:
    """
    Verify that an incoming webhook payload was sent legitimately by GitHub.

    Args:
        payload_body: Raw bytes of the request body.
        received_signature: The `X-Hub-Signature-256` header value from GitHub.

    Returns:
        True if the signature is valid; False otherwise.
    """
    # If no secret is configured, we explicitly bypass validation (development mode)
    if not settings.GITHUB_WEBHOOK_SECRET:
        return True

    if not received_signature:
        return False

    # The header format is "sha256=<hex_digest>"
    if not received_signature.startswith("sha256="):
        return False

    expected_digest = hmac.new(
        key=settings.GITHUB_WEBHOOK_SECRET.encode("utf-8"),
        msg=payload_body,
        digestmod=hashlib.sha256,
    ).hexdigest()

    expected_signature = f"sha256={expected_digest}"

    # Use constant-time comparison to prevent timing attacks
    return hmac.compare_digest(expected_signature, received_signature)
