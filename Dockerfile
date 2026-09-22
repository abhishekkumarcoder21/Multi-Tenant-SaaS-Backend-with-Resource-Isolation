# Multi-stage production Dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
COPY package*.json ./
RUN npm ci

# Copy source code and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Copy Lua scripts and migrations into dist folder for production runtime
RUN mkdir -p dist/rate-limiter/lua && cp src/rate-limiter/lua/*.lua dist/rate-limiter/lua/
RUN mkdir -p dist/database/migrations && cp src/database/migrations/*.sql dist/database/migrations/

# ─── Production Runner ───
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist

# Non-root user for security
USER node

EXPOSE 3000

CMD ["node", "dist/app.js"]
