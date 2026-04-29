# syntax=docker/dockerfile:1.7

# ---- build stage: install only production deps ------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime stage ----------------------------------------------------------
FROM node:22-alpine AS runtime

# Drop privileges. node:alpine ships a pre-baked "node" user (uid 1000).
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# Healthcheck hits /health every 30s; container reports unhealthy after 3 failures.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health > /dev/null || exit 1

USER node
CMD ["node", "src/index.js"]
