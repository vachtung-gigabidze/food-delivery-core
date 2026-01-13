#!/bin/sh

set -e

host="$1"
port="$2"
shift 2
cmd="$@"

echo "Ожидание запуска RabbitMQ на $host:$port..."

# Проверяем каждую секунду в течение 60 секунд
for i in `seq 1 60`; do
  if nc -z "$host" "$port"; then
    echo "RabbitMQ запущен!"
    exec $cmd
  fi
  echo "RabbitMQ еще не готов, ждем... ($i/60)"
  sleep 1
done

echo "Не удалось дождаться RabbitMQ за 60 секунд"
exit 1