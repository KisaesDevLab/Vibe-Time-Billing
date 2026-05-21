# syntax=docker/dockerfile:1.6
# Multi-stage production build for Vibe Time & Billing appliance.
# Final image bundles Chromium for Puppeteer PDF rendering (~300MB bloat).

# =============================================================================
# Stage 1: Dependencies
# =============================================================================
FROM node:24-bookworm-slim AS deps

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/portal/package.json apps/portal/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/types/package.json packages/types/
COPY packages/ui/package.json packages/ui/
COPY packages/core/package.json packages/core/

RUN pnpm install --frozen-lockfile

# =============================================================================
# Stage 2: Builder
# =============================================================================
FROM node:24-bookworm-slim AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Skip Chromium download — use system Chromium in runtime stage
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

RUN pnpm -r build

# Prune dev dependencies
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# =============================================================================
# Stage 3: Runtime
# =============================================================================
FROM node:24-bookworm-slim AS runtime

# Chromium for Puppeteer + fonts for invoice rendering
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-noto-cjk \
    ca-certificates \
    curl \
    postgresql-client \
    tini \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder /app/apps/worker/package.json ./apps/worker/
COPY --from=builder /app/apps/web/dist ./apps/web/dist
COPY --from=builder /app/apps/portal/dist ./apps/portal/dist
COPY --from=builder /app/packages ./packages
COPY ops/scripts ./ops/scripts
COPY seed ./seed

EXPOSE 3001 3002

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:3001/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/server.js"]
