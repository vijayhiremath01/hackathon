# Dockerfile for ReBin Backend + Python CV Engine
# Single-container image for AWS ECS Fargate deployment
# Build context: repository root (hackatthon/)

# ---------------------------------------------------------------
# Stage 1: System dependencies + Python + Node.js runtime
# ---------------------------------------------------------------
FROM node:20-slim AS runtime

WORKDIR /app

# Install system packages required by Python, OpenCV, and PyTorch (CPU)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ca-certificates \
    curl \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libfontconfig1 \
    && rm -rf /var/lib/apt/lists/* \
    && update-ca-certificates

# ---------------------------------------------------------------
# Stage 2: Node.js dependencies
# ---------------------------------------------------------------
# Copy Node.js lockfiles first for better layer caching
COPY backend/package.json backend/package-lock.json ./

RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------
# Stage 3: Python dependencies (CV engine runtime only)
# ---------------------------------------------------------------
# Create a virtual environment to avoid PEP 668 externally-managed
# environment restrictions on Debian 12. Install only the core
# Python packages required by ReBin CV engine (CPU-only).
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel && \
    /opt/venv/bin/pip install --no-cache-dir \
    "ultralytics>=8.4.0" \
    "torch>=2.14.0" \
    "torchvision>=0.29.0" \
    "opencv-python>=4.8.0,<5.0" \
    "pillow>=12.0.0" \
    "pydantic>=2.14.0" \
    "pyyaml>=6.0.0"

# Make venv Python available on PATH
ENV PATH="/opt/venv/bin:$PATH"

# ---------------------------------------------------------------
# Stage 4: Application source code
# ---------------------------------------------------------------
# Backend source
COPY backend/ ./backend/

# Python CV engine source + model weights
COPY waste-cv-engine/ ./waste-cv-engine/
COPY models/ ./models/

# ---------------------------------------------------------------
# Stage 5: Runtime user, environment, and entrypoint
# ---------------------------------------------------------------
# Create a non-root user for running the application
RUN groupadd -r appuser && useradd -r -g appuser appuser

# Ensure the app user can write to temp, logs, and output directories
RUN mkdir -p /app/backend/temp /app/waste-cv-engine/logs \
    /app/waste-cv-engine/captured_images \
    /app/waste-cv-engine/scan_records \
    /app/waste-cv-engine/detection_previews && \
    chown -R appuser:appuser /app

USER appuser

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
# Point the CV engine at the container-resident model and source tree
ENV WASTE_CV_MODEL_PATH=/app/waste-cv-engine/models/yolo26n.pt
# Point to the Python virtual environment (created in Stage 3)
ENV WASTE_CV_PYTHON_PATH=/opt/venv/bin/python3
ENV APP_PROJECT_ROOT=/app
# Python engine output directories (container-local, non-persistent)
ENV WASTE_CV_CAPTURED_IMAGES_DIR=/app/waste-cv-engine/captured_images
ENV WASTE_CV_SCAN_RECORDS_DIR=/app/waste-cv-engine/scan_records
ENV WASTE_CV_DETECTION_PREVIEWS_DIR=/app/waste-cv-engine/detection_previews
ENV WASTE_CV_LOGS_DIR=/app/waste-cv-engine/logs

# Port the Express API listens on
EXPOSE 3000

# Health check: lightweight, no CV inference, no NVIDIA API call
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f -s http://localhost:3000/api/health || exit 1

# Start the Express backend (which spawns the Python CV engine as needed)
CMD ["npx", "tsx", "backend/src/index.ts"]