#!/bin/bash

echo "Запуск инфраструктуры..."
docker-compose up -d postgres-order redis rabbitmq

echo "Ожидание запуска RabbitMQ (30 секунд)..."
sleep 30

echo "Запуск бизнес-сервисов..."
docker-compose up -d order-service delivery-service notification-service api-gateway

echo "Все сервисы запущены!"
echo "API Gateway: http://localhost:3000"
echo "RabbitMQ UI: http://localhost:15672 (admin/admin123)"