FROM node:22-slim

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.mjs ./
COPY public ./public

USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
