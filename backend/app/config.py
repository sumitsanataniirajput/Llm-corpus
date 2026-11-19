"""CORPUS ULTIMATE — Application configuration.

Loads settings from environment variables with safe defaults.
Never hardcode secrets here. Required variables are validated at startup.
"""
from pydantic_settings import BaseSettings
from pydantic import field_validator
from typing import List, Union


class Settings(BaseSettings):
    # ── Server ──
    PORT: int = 8000
    ALLOWED_HOSTS: List[str] = ["*"]  # Safe dev default; override in production
    # Only these immediate peers may supply X-Forwarded-For / X-Real-IP. Empty
    # by default: a public client cannot spoof its rate-limit identity.
    TRUSTED_PROXY_IPS: List[str] = []

    # ── Supabase ──
    SUPABASE_URL: str = ""
    # Modern publishable key (preferred) or legacy anon key
    SUPABASE_PUBLISHABLE_KEY: str = ""
    # Backward-compatible alias for the same public key
    SUPABASE_ANON_KEY: str = ""
    SUPABASE_SERVICE_ROLE_KEY: str = ""  # Backend only, never in frontend

    # ── Database ──
    DATABASE_URL: str = ""


    @field_validator("DATABASE_URL", mode="before")
    @classmethod
    def normalize_database_url(cls, v: str) -> str:
        """Ensure PostgreSQL URLs use the asyncpg driver required by SQLAlchemy."""
        if not isinstance(v, str):
            return v
        if v.startswith("postgres://"):
            return "postgresql+asyncpg://" + v[len("postgres://"):]
        if v.startswith("postgresql://"):
            return "postgresql+asyncpg://" + v[len("postgresql://"):]
        if v.startswith("postgresql+psycopg2://"):
            return "postgresql+asyncpg://" + v[len("postgresql+psycopg2://"):]
        return v

    # ── Security (for internal app tokens only, NOT for Supabase JWT verification) ──
    SECRET_KEY: str = ""
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30

    # ── Worker auth ──
    WORKER_AUTH_SECRET: str = ""

    # ── Provider credential encryption (AES-256-GCM) ──
    # 32 random bytes, base64 or hex. Render environment variable; never the repo.
    # When empty, saving a provider credential is refused instead of storing it
    # insecurely (see app/services/crypto.py).
    CREDENTIAL_ENCRYPTION_KEY: str = ""
    # Per-IP request budget for the API middleware. 60/min by default; raise it
    # deliberately for a load test or a trusted internal client pool.
    RATE_LIMIT_REQUESTS_PER_MINUTE: int = 60

    # ── External teacher providers ──
    # Timeouts and concurrency are configuration, not capability claims.
    PROVIDER_REQUEST_TIMEOUT_SECONDS: float = 90.0
    PROVIDER_MAX_CONCURRENCY: int = 4
    PROVIDER_MAX_RETRIES: int = 2
    DISTILLATION_MAX_EXAMPLES_PER_RUN: int = 200
    DISTILLATION_MAX_SOURCE_CHARS: int = 400_000

    # ── API ──
    API_BASE_URL: str = "http://localhost:8000"
    CORS_ORIGINS: List[str] = [
        "https://corpus-ultimate-web.onrender.com",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://localhost:41625",
        "http://127.0.0.1:41625",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]

    # ── Storage ──
    STORAGE_BUCKET: str = "corpus-storage"
    # Small fallback multipart route only; normal browser uploads use direct TUS.
    MAX_UPLOAD_SIZE: int = 6 * 1024 * 1024

    # ── Resource limits ──
    MAX_PARAMETERS_DEFAULT: int = 100000000
    MAX_CONTEXT_LENGTH: int = 4096
    MAX_VOCAB_SIZE: int = 100000

    # ── Logging ──
    LOG_LEVEL: str = "INFO"

    # ── Training ──
    DEFAULT_DEVICE: str = "cpu"

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def parse_cors_origins(cls, v: Union[str, List[str]]) -> List[str]:
        """Accept comma-separated string or list for CORS_ORIGINS env var."""
        if isinstance(v, str):
            return [origin.strip() for origin in v.split(",") if origin.strip()]
        return v

    @field_validator("ALLOWED_HOSTS", mode="before")
    @classmethod
    def parse_allowed_hosts(cls, v: Union[str, List[str]]) -> List[str]:
        """Accept comma-separated string or list for ALLOWED_HOSTS env var."""
        if isinstance(v, str):
            return [h.strip() for h in v.split(",") if h.strip()]
        return v

    @field_validator("TRUSTED_PROXY_IPS", mode="before")
    @classmethod
    def parse_trusted_proxy_ips(cls, v: Union[str, List[str]]) -> List[str]:
        """Accept comma-separated string or list for TRUSTED_PROXY_IPS."""
        if isinstance(v, str):
            return [ip.strip() for ip in v.split(",") if ip.strip()]
        return v

    @field_validator("SECRET_KEY")
    @classmethod
    def validate_secret_key(cls, v: str) -> str:
        """Reject insecure default SECRET_KEY values."""
        if not v:
            raise ValueError(
                "SECRET_KEY must be set. Do not leave it empty."
            )
        if "change-me" in v.lower() or v.lower() in ("secret", "development", "dev"):
            raise ValueError(
                "SECRET_KEY must be set to a secure, non-default value. "
                "Do not use 'change-me' or similar insecure defaults."
            )
        return v

    @field_validator("WORKER_AUTH_SECRET")
    @classmethod
    def validate_worker_secret(cls, v: str) -> str:
        """Reject insecure default WORKER_AUTH_SECRET values."""
        if not v:
            raise ValueError(
                "WORKER_AUTH_SECRET must be set. Do not leave it empty."
            )
        if "change-me" in v.lower() or v.lower() in ("worker-secret", "development", "dev"):
            raise ValueError(
                "WORKER_AUTH_SECRET must be set to a secure, non-default value. "
                "Do not use 'change-me-worker-secret' or similar insecure defaults."
            )
        return v

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = True


settings = Settings()


def validate_required_config() -> List[str]:
    """Return list of missing required configuration keys."""
    missing = []
    if not settings.SUPABASE_URL:
        missing.append("SUPABASE_URL")
    if not settings.SUPABASE_ANON_KEY:
        missing.append("SUPABASE_ANON_KEY")
    if not settings.DATABASE_URL:
        missing.append("DATABASE_URL")
    return missing
