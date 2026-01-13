const amqp = require("amqplib");

async function initializeRabbitMQ() {
  const connection = await amqp.connect("amqp://admin:admin123@rabbitmq:5672");
  const channel = await connection.createChannel();

  // Создаем все необходимые exchanges
  await channel.assertExchange("order-events", "topic", { durable: true });
  await channel.assertExchange("order-events-dlx", "topic", { durable: true });

  console.log(
    "RabbitMQ инициализирован: созданы exchanges order-events и order-events-dlx"
  );

  await channel.close();
  await connection.close();
}

// Запуск при старте контейнера
initializeRabbitMQ().catch(console.error);
