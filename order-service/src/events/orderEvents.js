class OrderEventPublisher {
  constructor() {
    this.maxRetries = 10;
    this.retryDelay = 2000; // 2 секунды
  }

  async connect() {
    let retries = 0;

    while (retries < this.maxRetries) {
      try {
        const rabbitmqUrl =
          process.env.RABBITMQ_URL || "amqp://admin:admin123@rabbitmq:5672";

        this.connection = await amqp.connect(rabbitmqUrl, {
          heartbeat: 30,
          connectionTimeout: 10000,
        });

        this.channel = await this.connection.createChannel();

        await this.channel.assertExchange("order-events", "topic", {
          durable: true,
          autoDelete: false,
        });

        logger.info("Подключение к RabbitMQ установлено");
        return;
      } catch (error) {
        retries++;
        logger.warn(
          `Попытка ${retries}/${this.maxRetries} подключения к RabbitMQ не удалась: ${error.message}`
        );

        if (retries >= this.maxRetries) {
          logger.error(
            "Достигнуто максимальное количество попыток подключения к RabbitMQ"
          );
          throw error;
        }

        // Экспоненциальная задержка
        const delay = this.retryDelay * Math.pow(2, retries - 1);
        logger.info(`Повторная попытка через ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
