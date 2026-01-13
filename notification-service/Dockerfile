FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --production

FROM node:18-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# EXPOSE 3003
# USER node
# CMD ["node", "src/consumers/notificationConsumer.js"]

# Копируем скрипт ожидания
COPY wait-for-rabbitmq.sh /wait-for-rabbitmq.sh
RUN chmod +x /wait-for-rabbitmq.sh

EXPOSE 3003
CMD ["/wait-for-rabbitmq.sh", "rabbitmq", "5672", "node", "src/consumers/notificationConsumer.js"]