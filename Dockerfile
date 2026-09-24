# Fork preview image for the t3 server (no secrets).
# Uses only public T3 Connect identifiers from .env.example.
# Build: docker build -t t3code-fork .
# Run:   docker run --rm -p 3773:3773 -v t3-data:/home/node/.t3 t3code-fork

FROM node:24-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@11.10.0 --activate \
  && apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential pkg-config libsecret-1-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Copy everything the build needs (.dockerignore drops .git/.repos/node_modules/release).
COPY . .

RUN pnpm install --frozen-lockfile \
  && cp .env.example .env \
  && pnpm exec vp run --filter t3 build

FROM node:24-bookworm-slim AS runner

ENV NODE_ENV=production
ENV T3CODE_PORT=3773

WORKDIR /app

# Copy the built repo (dist + production-capable node_modules). Large but
# reliable for a fork preview; optimize with `pnpm deploy` later if needed.
COPY --from=builder /repo /app

RUN mkdir -p /home/node/.t3 && chown -R node:node /app /home/node/.t3

USER node

EXPOSE 3773
VOLUME ["/home/node/.t3"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('net').connect(3773,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"

CMD ["node", "apps/server/dist/bin.mjs"]
