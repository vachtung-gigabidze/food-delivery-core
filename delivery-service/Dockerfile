FROM node:18-alpine
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .

# Копируем скрипт ожидания
COPY wait-for-rabbitmq.sh /wait-for-rabbitmq.sh
RUN chmod +x /wait-for-rabbitmq.sh

EXPOSE 3002
CMD ["/wait-for-rabbitmq.sh", "rabbitmq", "5672", "node", "src/server.js"]