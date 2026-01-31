ARG NODE_VERSION=24
FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
COPY . /app
WORKDIR /app

FROM base AS prod-deps
WORKDIR /app
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM base AS dev-deps
WORKDIR /app
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm run build

FROM base AS prod
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=build /app/build /app/build
RUN ln -s /app/build/common '/app/node_modules/@common'
RUN ln -s /app/build/common '/app/node_modules/common'
EXPOSE 443
# ENV NODE_PATH=/app/build
CMD [ "node", "/app/build/src/server.js" ]

FROM base AS dev
COPY --from=dev-deps /app/node_modules /app/node_modules
# RUN ln -s /app/build/common '/app/node_modules/@common'
# RUN ln -s /app/build/common '/app/node_modules/common'
EXPOSE 443
# ENV NODE_PATH=/app/build
CMD [ "pnpm", "start" ]
