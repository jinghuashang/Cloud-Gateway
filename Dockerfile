FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY public/ ./public/

ENV NODE_ENV=production
ENV PORT=8088
ENV DATA_DIR=/app/data

EXPOSE 8088

CMD ["node", "server.js"]
