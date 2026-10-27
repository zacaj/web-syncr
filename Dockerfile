# Keep NODE_VERSION in sync with .nvmrc (major only; patch releases come from rebuilding with --pull).
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
# @zacaj/* come from the private npm.zacaj.com registry: the committed .npmrc only maps the scope;
# the auth token is mounted per install step as the `npmrc` build secret (~/.npmrc locally via
# .zdockerrc, NPM_TOKEN in CI), so it never lands in an image layer.
COPY . /app
WORKDIR /app

FROM base AS prod-deps
WORKDIR /app
RUN --mount=type=cache,id=pnpm,target=/pnpm/store --mount=type=secret,id=npmrc,target=/root/.npmrc pnpm install --prod --frozen-lockfile

FROM base AS dev-deps
WORKDIR /app
RUN --mount=type=cache,id=pnpm,target=/pnpm/store --mount=type=secret,id=npmrc,target=/root/.npmrc pnpm install --frozen-lockfile

FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store --mount=type=secret,id=npmrc,target=/root/.npmrc pnpm install --frozen-lockfile
RUN pnpm run build

FROM base AS prod
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=build /app/build /app/build
EXPOSE 443
# ENV NODE_PATH=/app/build
CMD [ "node", "/app/build/src/server.js" ]

FROM base AS dev
COPY --from=dev-deps /app/node_modules /app/node_modules
EXPOSE 443
# ENV NODE_PATH=/app/build
# config comes from the container env (compose env_file), not a baked-in .env
CMD [ "node_modules/.bin/tsx", "src/server" ]
