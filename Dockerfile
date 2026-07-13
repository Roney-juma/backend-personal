# syntax=docker/dockerfile:1
# Single image for both the API and the worker — pick the process with the
# container command (see docker-compose / ECS task defs):
#   API:    node src/app.js
#   Worker: node src/worker.js
#
# Multi-stage: install prod deps in a builder, copy into a slim runtime that
# runs as a non-root user.

# ── deps ──────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
# sharp needs a couple of native libs at build time on alpine.
RUN apk add --no-cache libc6-compat
COPY package*.json ./
RUN npm ci --omit=dev

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# curl for the container HEALTHCHECK; tini for correct signal handling so
# SIGTERM reaches Node and the app's graceful-shutdown path runs.
RUN apk add --no-cache curl tini

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Drop privileges.
RUN addgroup -S ave && adduser -S ave -G ave \
  && chown -R ave:ave /app
USER ave

EXPOSE 3000

# Liveness at the container level; ALB/ECS also probe /ready over the network.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/app.js"]
