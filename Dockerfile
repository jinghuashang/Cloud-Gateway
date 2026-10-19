FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

# 使用锁文件安装，保证依赖版本可复现
RUN npm ci --omit=dev --no-audit --no-fund

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
