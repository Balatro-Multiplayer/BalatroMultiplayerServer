# Discord rank-role bot. Built from the REPO ROOT, like apps/server:
#   docker build -f apps/discord-bot/Dockerfile .
FROM node:22-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/discord-bot/package.json ./apps/discord-bot/

RUN pnpm install --frozen-lockfile --filter balatro-multiplayer-discord-bot...

COPY apps/discord-bot/ ./apps/discord-bot/

RUN pnpm --filter balatro-multiplayer-discord-bot build

ENV NODE_ENV=production

WORKDIR /app/apps/discord-bot
CMD ["node", "dist/main.js"]
