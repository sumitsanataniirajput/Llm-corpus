# ========================================
# CORPUS ULTIMATE — Backend Dockerfile
# Production-ready for Render deployment
# ========================================
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies (minimal — no unnecessary build tools)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for runtime
RUN groupadd -r corpus && useradd -r -g corpus -d /app -s /sbin/nologin corpus

# Copy and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code (excluding .env, credentials, caches)
COPY --chown=corpus:corpus . .

# Switch to non-root user
USER corpus

# Expose API port (Render provides $PORT at runtime)
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${PORT:-8000}/health || exit 1

# Run the server — use Render-provided PORT, default 8000 for local dev
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
