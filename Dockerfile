FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

# 可通过 --build-arg NPM_REGISTRY=https://registry.npmmirror.com 指定构建期依赖源
ARG NPM_REGISTRY=https://registry.npmjs.org
# 使用锁文件安装，保证依赖版本可复现
RUN npm ci --omit=dev --no-audit --no-fund --registry="${NPM_REGISTRY}" --replace-registry-host=always

COPY server.js ./
COPY lib/ ./lib/
COPY public/ ./public/

ENV NODE_ENV=production
ENV PORT=8088
ENV DATA_DIR=/app/data

# 以非 root 用户运行；数据目录需可写（挂载宿主机目录时请确保 uid 1000 可写）
RUN mkdir -p /app/data /app/ssl && chown -R node:node /app
USER node

EXPOSE 8088

CMD ["node", "server.js"]
