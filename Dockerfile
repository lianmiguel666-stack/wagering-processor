FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* bun.lockb* ./
RUN bun install --production

FROM oven/bun:1-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
USER bun
EXPOSE 3000
# Bun runs the TypeScript sources directly (no build step).
CMD ["bun", "run", "src/main.ts"]
