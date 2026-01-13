const amqp = require("amqplib");
const winston = require("winston");
const { v4: uuidv4 } = require("uuid");

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "events.log" }),
  ],
});

class OrderEventPublisher {
  constructor() {
    this.connection = null;
    this.channel = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
  }

  async connect() {
    try {
      const rabbitmqUrl =
        process.env.RABBITMQ_URL || "amqp://admin:admin123@rabbitmq:5672";

      this.connection = await amqp.connect(rabbitmqUrl, {
        heartbeat: 30,
        connectionTimeout: 10000,
      });

      this.channel = await this.connection.createChannel();

      // Объявляем exchange
      await this.channel.assertExchange("order-events", "topic", {
        durable: true,
        autoDelete: false,
      });

      // Объявляем Dead Letter Exchange
      await this.channel.assertExchange("order-events-dlx", "topic", {
        durable: true,
      });

      logger.info("Подключение к RabbitMQ установлено");
      this.reconnectAttempts = 0;

      // Обработчики событий соединения
      this.connection.on("close", () => {
        logger.warn(
          "Соединение с RabbitMQ закрыто. Попытка переподключения..."
        );
        this.scheduleReconnect();
      });

      this.connection.on("error", (err) => {
        logger.error("Ошибка соединения RabbitMQ:", err);
      });

      this.channel.on("error", (err) => {
        logger.error("Ошибка канала RabbitMQ:", err);
      });
    } catch (error) {
      logger.error("Не удалось подключиться к RabbitMQ:", error);
      this.scheduleReconnect();
      throw error;
    }
  }

  scheduleReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay =
        this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

      logger.info(
        `Повторная попытка подключения через ${delay}ms (попытка ${this.reconnectAttempts})`
      );

      setTimeout(() => {
        this.connect().catch(() => {
          // Ошибка уже залогирована в connect()
        });
      }, delay);
    } else {
      logger.error(
        "Достигнуто максимальное количество попыток переподключения к RabbitMQ"
      );
    }
  }

  async publish(eventType, routingKey, data, options = {}) {
    try {
      if (!this.channel) {
        throw new Error("Канал RabbitMQ не инициализирован");
      }

      const event = {
        id: uuidv4(),
        type: eventType,
        timestamp: new Date().toISOString(),
        correlationId: options.correlationId,
        data: data,
      };

      const messageBuffer = Buffer.from(JSON.stringify(event));

      const publishOptions = {
        persistent: true,
        contentType: "application/json",
        timestamp: Date.now(),
        headers: {
          ...options.headers,
          "x-event-id": event.id,
          "x-event-type": eventType,
        },
      };

      // Добавляем retry для публикации
      let retries = 3;
      while (retries > 0) {
        try {
          const published = this.channel.publish(
            "order-events",
            routingKey,
            messageBuffer,
            publishOptions
          );

          if (published) {
            logger.info("Событие опубликовано", {
              eventId: event.id,
              type: eventType,
              routingKey,
              correlationId: options.correlationId,
            });

            return event.id;
          } else {
            throw new Error("Сообщение не было опубликовано (вернулось false)");
          }
        } catch (publishError) {
          retries--;

          if (retries === 0) {
            throw publishError;
          }

          logger.warn(`Повторная попытка публикации (осталось ${retries})`, {
            eventType,
            error: publishError.message,
          });

          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    } catch (error) {
      logger.error("Ошибка при публикации события:", {
        eventType,
        routingKey,
        error: error.message,
        stack: error.stack,
        correlationId: options.correlationId,
      });

      // Возвращаем ошибку, но не падаем
      throw error;
    }
  }

  async publishOrderCreated(order, correlationId) {
    return this.publish(
      "ORDER_CREATED",
      "order.created",
      {
        orderId: order.id,
        userId: order.userId,
        restaurantId: order.restaurantId,
        totalAmount: order.totalAmount,
        deliveryAddress: order.deliveryAddress,
        items: order.items,
        estimatedDeliveryTime: order.estimatedDeliveryTime,
      },
      { correlationId }
    );
  }

  async publishOrderStatusChanged(
    orderId,
    oldStatus,
    newStatus,
    correlationId
  ) {
    return this.publish(
      "ORDER_STATUS_CHANGED",
      "order.status.changed",
      {
        orderId,
        oldStatus,
        newStatus,
        timestamp: new Date().toISOString(),
      },
      { correlationId }
    );
  }

  async publishPaymentProcessed(
    orderId,
    paymentStatus,
    paymentId,
    correlationId
  ) {
    return this.publish(
      "PAYMENT_PROCESSED",
      "order.payment.processed",
      {
        orderId,
        paymentStatus,
        paymentId,
        timestamp: new Date().toISOString(),
      },
      { correlationId }
    );
  }

  async publishDeliveryAssigned(
    orderId,
    courierId,
    estimatedArrival,
    correlationId
  ) {
    return this.publish(
      "DELIVERY_ASSIGNED",
      "order.delivery.assigned",
      {
        orderId,
        courierId,
        estimatedArrival,
        timestamp: new Date().toISOString(),
      },
      { correlationId }
    );
  }

  async close() {
    try {
      if (this.channel) {
        await this.channel.close();
        logger.info("Канал RabbitMQ закрыт");
      }

      if (this.connection) {
        await this.connection.close();
        logger.info("Соединение RabbitMQ закрыто");
      }
    } catch (error) {
      logger.error("Ошибка при закрытии соединения RabbitMQ:", error);
    }
  }
}

// Создаем singleton экземпляр
let instance = null;

const getOrderEventPublisher = async () => {
  if (!instance) {
    instance = new OrderEventPublisher();
    await instance.connect();
  }
  return instance;
};

// Graceful shutdown
process.on("SIGTERM", async () => {
  if (instance) {
    await instance.close();
  }
  process.exit(0);
});

process.on("SIGINT", async () => {
  if (instance) {
    await instance.close();
  }
  process.exit(0);
});

module.exports = {
  OrderEventPublisher,
  getOrderEventPublisher,
};
