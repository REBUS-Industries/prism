# PRISM Server — multi-stage build
# Phase 0: builds a basic node image; Phase 1 fills in DB migrations on boot.

# -------- builder --------
FROM node:22-alpine AS builder
WORKDIR /build

# Web assets (admin + convert SPA) are built first so the server can serve them as static.
# Phase 4 will populate web/. Until then the COPY of an empty dir is a no-op.
COPY web/ ./web/
RUN if [ -f web/package.json ]; then \
      cd web && npm ci && npm run build; \
    else \
      echo "web/ not yet built — Phase 4 will populate this"; \
    fi

# Server build
COPY server/package.json server/tsconfig.json ./server/
WORKDIR /build/server
RUN npm ci
COPY server/src ./src
COPY shared ../shared
RUN npm run build

# -------- runtime --------
FROM node:22-alpine AS runtime
WORKDIR /prism

# Only production deps
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /build/server/dist ./dist
COPY --from=builder /build/web/dist ./web-dist 2>/dev/null || true

ENV NODE_ENV=production
ENV PORT=8765
EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:8765/health || exit 1

CMD ["node", "dist/main.js"]
