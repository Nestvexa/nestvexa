# syntax=docker/dockerfile:1
# Showcase image, built from the repository root (see docker-compose.yml):
#   docker compose -f examples/showcase/docker-compose.yml build
# It installs and builds only the showcase and the workspace packages it
# depends on, then runs as the unprivileged `node` user.
FROM node:24-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate
COPY . .
RUN pnpm install --frozen-lockfile --filter "@nestvexa/example-showcase..."
RUN pnpm --filter "@nestvexa/example-showcase..." build

FROM build AS runtime
ENV HOST=0.0.0.0 PORT=3124 SHOWCASE_DATA_DIR=/var/lib/showcase
RUN mkdir -p /var/lib/showcase && chown node:node /var/lib/showcase
USER node
WORKDIR /repo/examples/showcase
EXPOSE 3124
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
