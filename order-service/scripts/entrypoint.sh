#!/bin/sh

echo "Waiting for PostgreSQL to start..."
while ! nc -z postgres-order 5432; do
  sleep 1
done
echo "PostgreSQL started"

echo "Waiting for RabbitMQ to start..."
while ! nc -z rabbitmq 5672; do
  sleep 1
done
echo "RabbitMQ started"

echo "Waiting for Redis to start..."
while ! nc -z redis 6379; do
  sleep 1
done
echo "Redis started"

# Запуск миграций
echo "Running database migrations..."
node src/migrations/001_create_orders_table.js

# Запуск основного приложения
echo "Starting order service..."
exec "$@"