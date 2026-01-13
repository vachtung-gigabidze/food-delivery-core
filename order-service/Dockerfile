FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --production

FROM node:18-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# Установка healthcheck
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Запуск миграций при старте
RUN chmod +x ./scripts/entrypoint.sh

EXPOSE 3001
USER node

ENTRYPOINT ["./scripts/entrypoint.sh"]
CMD ["node", "src/server.js"]