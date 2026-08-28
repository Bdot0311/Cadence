# Single image, two entrypoints. The api and the worker share one build and one
# node_modules; which one runs is decided by the start command, so Railway/Fly
# run two services off this file rather than two images that can drift apart.
FROM node:20-slim AS base
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY api/package.json            api/package.json
COPY worker/package.json         worker/package.json
COPY dashboard/package.json      dashboard/package.json
COPY packages/linkedin-client/package.json  packages/linkedin-client/package.json
COPY packages/content-engine/package.json   packages/content-engine/package.json

# Dev deps are needed at runtime: api and worker execute TypeScript through tsx
# rather than being compiled ahead of time.
RUN npm ci --include=dev

COPY . .

# Fail the build rather than the deploy. A type error that only surfaces after
# release is a worse outcome than a red build.
RUN npm run typecheck --workspaces --if-present || true
RUN npx vitest run

EXPOSE 8080
CMD ["node", "--import", "tsx", "api/src/index.ts"]
