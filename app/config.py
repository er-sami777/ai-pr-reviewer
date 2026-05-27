"""
Application Configuration Loader
=================================
Loads runtime settings from environment variables and the .env file
using Pydantic for strict validation and type safety.
"""

import os
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Centralized application settings loaded from .env file."""

    # Groq AI Configuration
    GROQ_API_KEY: str
    GROQ_MODEL: str = "qwen/qwen3-32b"

    # GitHub Configuration
    GITHUB_TOKEN: str
    GITHUB_WEBHOOK_SECRET: str = ""

    # Coding Standards File Path
    CODING_STANDARDS_PATH: str = "./coding_standards.md"

    # Server Configuration
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    LOG_LEVEL: str = "info"

    # Review Configuration
    MAX_TOKENS_PER_REVIEW: int = 4000
    MIN_FILE_SIZE_FOR_REVIEW: int = 10

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )


# Global settings singleton
settings = Settings()


def load_coding_standards() -> str:
    """
    Load the user-defined coding standards Markdown file.
    Returns the entire content as a string. If the file is missing,
    returns a sane default fallback message.
    """
    standards_path = Path(settings.CODING_STANDARDS_PATH)

    if not standards_path.is_absolute():
        # Resolve path relative to the backend project root
        project_root = Path(__file__).parent.parent
        standards_path = project_root / standards_path

    if standards_path.exists():
        try:
            return standards_path.read_text(encoding="utf-8")
        except Exception as exc:
            print(f"⚠️ Failed to read coding standards file: {exc}")
            return ""

    print(
        f"⚠️ Coding standards file not found at {standards_path}. "
        "Proceeding with default AI review baseline."
    )
    return ""
