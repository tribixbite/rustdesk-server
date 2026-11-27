# RustDesk API + web console (api/), built from this repository.
# Build context: the repository root (Railway uploads the whole tree; the
# service sets RAILWAY_DOCKERFILE_PATH=api/Dockerfile). See docs/api.md.

FROM oven/bun:1.3.10-alpine AS build
WORKDIR /app
COPY api/package.json api/bun.lock ./
RUN bun install --frozen-lockfile
COPY api/ ./
# Type errors fail the image build instead of the running service.
RUN bunx tsc --noEmit
RUN bun run build:web

FROM oven/bun:1.3.10-alpine
WORKDIR /app
COPY api/package.json api/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/src ./src
COPY --from=build /app/dist ./dist
ENV API_PORT=21114 \
    DATABASE_PATH=/data/rustdesk-api.sqlite3 \
    WEB_DIR=/app/dist/web
EXPOSE 21114
# bun images run as the "bun" user; the Railway volume at /data is owned by root.
USER root
CMD ["bun", "src/index.ts"]
