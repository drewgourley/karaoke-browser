# ── Stage 1: build the React app ─────────────────────────────────────────────
FROM node:18-alpine AS app-builder
WORKDIR /build

COPY package*.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/app/package.json ./packages/app/
RUN npm ci

COPY packages/shared ./packages/shared
COPY packages/app ./packages/app
RUN npm run build:shared && npm run build:app

# ── Stage 2: build the API ───────────────────────────────────────────────────
FROM node:18-alpine AS api-builder
WORKDIR /build

COPY package*.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/api/package.json ./packages/api/
RUN npm ci

COPY packages/shared ./packages/shared
COPY packages/api ./packages/api
RUN npm run build:shared && npm run build:api

# ── Stage 3: production image ────────────────────────────────────────────────
FROM node:18-alpine
WORKDIR /app

# Production dependencies only
COPY package*.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/api/package.json ./packages/api/
RUN npm ci --omit=dev

# Compiled API
COPY --from=api-builder /build/packages/api/dist ./packages/api/dist

# React build (served by the API at runtime)
COPY --from=app-builder /build/packages/app/dist ./packages/app/dist

EXPOSE 3444

CMD ["node", "packages/api/dist/app.js"]
