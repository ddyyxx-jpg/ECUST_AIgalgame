# 试用镜像：Node 22 + 现有 tsx 入口；Web 由宿主机 Nginx 托管。
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=development

COPY package.json package-lock.json tsconfig.json vitest.config.ts ./
COPY packages ./packages
COPY apps ./apps
COPY content ./content
COPY scripts ./scripts

RUN npm ci

# 运行时不需要编译：现有服务用 tsx 直接跑 TypeScript
ENV NODE_ENV=production
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8787
CMD ["./node_modules/.bin/tsx", "apps/server/src/main.ts"]
