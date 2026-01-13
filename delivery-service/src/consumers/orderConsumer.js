const amqplib = require("amqplib");
const winston = require("winston");
const redis = require("redis");
const axios = require("axios");

// Настройка логгера
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: "delivery-consumer" },
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "delivery-consumer.log" }),
  ],
});

class DeliveryConsumer {
  constructor() {
    this.connection = null;
    this.channel = null;
    this.redisClient = null;
    this.maxRetries = 3;
    this.retryDelay = 1000;
  }

  async initialize() {
    try {
      // Подключение к Redis
      this.redisClient = redis.createClient({
        url: process.env.REDIS_URL || "redis://redis:6379",
      });

      await this.redisClient.connect();
      logger.info("Redis connected for delivery consumer");

      // Подключение к RabbitMQ
      await this.connectToRabbitMQ();
    } catch (error) {
      logger.error("Failed to initialize delivery consumer:", error);
      setTimeout(() => this.initialize(), 5000);
    }
  }

  async connectToRabbitMQ() {
    try {
      const rabbitmqUrl =
        process.env.RABBITMQ_URL || "amqp://admin:admin123@rabbitmq:5672";

      this.connection = await amqplib.connect(rabbitmqUrl, {
        heartbeat: 30,
      });

      this.channel = await this.connection.createChannel();

      // Объявляем exchange
      await this.channel.assertExchange("order-events", "topic", {
        durable: true,
      });

      // Создаем очередь для сервиса доставки
      const queueResult = await this.channel.assertQueue(
        "delivery-service-queue",
        {
          durable: true,
        //   arguments: {
        //     "x-dead-letter-exchange": "order-events-dlx",
        //     "x-dead-letter-routing-key": "delivery.dead-letter",
        //   },
        }
      );

      // Биндим очередь к событиям заказов
      await this.channel.bindQueue(
        queueResult.queue,
        "order-events",
        "order.created"
      );
      await this.channel.bindQueue(
        queueResult.queue,
        "order-events",
        "order.status.changed"
      );
      await this.channel.bindQueue(
        queueResult.queue,
        "order-events",
        "order.payment.processed"
      );

      // Создаем DLQ (Dead Letter Queue)
      // await this.channel.assertQueue("delivery-service-dlq", { durable: true });
      // await this.channel.bindQueue(
      //   "delivery-service-dlq",
      //   "order-events-dlx",
      //   "delivery.dead-letter"
      // );

      logger.info("Connected to RabbitMQ and queue established");

      // Начинаем прослушивание
      await this.startConsuming(queueResult.queue);
    } catch (error) {
      logger.error("Failed to connect to RabbitMQ:", error);
      throw error;
    }
  }

  async startConsuming(queueName) {
    try {
      await this.channel.consume(
        queueName,
        async (message) => {
          if (message !== null) {
            try {
              const event = JSON.parse(message.content.toString());
              const correlationId = event.correlationId || `evt_${Date.now()}`;

              logger.info("Event received", {
                correlationId,
                type: event.type,
                routingKey: message.fields.routingKey,
              });

              // Обработка события
              await this.handleEvent(event, correlationId);

              // Подтверждаем обработку
              this.channel.ack(message);
            } catch (error) {
              logger.error("Error processing message", {
                error: error.message,
                content: message.content.toString(),
              });

              // Если превышено количество попыток - отправляем в DLQ
              const headers = message.properties.headers || {};
              const retryCount = headers["x-retry-count"] || 0;

              if (retryCount < this.maxRetries) {
                // Повторная попытка с задержкой
                headers["x-retry-count"] = retryCount + 1;

                this.channel.nack(message, false, false);

                // Задержка перед повторной попыткой
                await new Promise((resolve) =>
                  setTimeout(resolve, this.retryDelay * Math.pow(2, retryCount))
                );
              } else {
                // Отправляем в DLQ
                this.channel.nack(message, false, false);
                logger.warn("Message sent to DLQ after max retries");
              }
            }
          }
        },
        {
          noAck: false,
          consumerTag: "delivery-service-consumer",
        }
      );

      logger.info("Started consuming messages from queue:", queueName);
    } catch (error) {
      logger.error("Error starting consumer:", error);
      throw error;
    }
  }

  async handleEvent(event, correlationId) {
    switch (event.type) {
      case "ORDER_CREATED":
        await this.handleOrderCreated(event.data, correlationId);
        break;

      case "ORDER_STATUS_CHANGED":
        if (event.data.newStatus === "READY_FOR_DELIVERY") {
          await this.handleOrderReadyForDelivery(event.data, correlationId);
        }
        break;

      case "PAYMENT_PROCESSED":
        if (event.data.paymentStatus === "PAID") {
          await this.handlePaymentProcessed(event.data, correlationId);
        }
        break;

      default:
        logger.debug("Unhandled event type:", event.type);
    }
  }

  async handleOrderCreated(orderData, correlationId) {
    logger.info("Processing new order for delivery", {
      correlationId,
      orderId: orderData.orderId,
      userId: orderData.userId,
    });

    // Сохраняем геоданные доставки
    const { deliveryAddress } = orderData;

    if (deliveryAddress && deliveryAddress.lat && deliveryAddress.lng) {
      await this.redisClient.geoAdd("pending-deliveries", {
        longitude: deliveryAddress.lng,
        latitude: deliveryAddress.lat,
        member: orderData.orderId,
      });

      // Сохраняем детали доставки
      await this.redisClient.hSet(`delivery:info:${orderData.orderId}`, {
        orderId: orderData.orderId,
        userId: orderData.userId,
        address: deliveryAddress.address,
        lat: deliveryAddress.lat,
        lng: deliveryAddress.lng,
        status: "pending",
        createdAt: new Date().toISOString(),
      });

      logger.info("Order delivery info saved", {
        correlationId,
        orderId: orderData.orderId,
        location: { lat: deliveryAddress.lat, lng: deliveryAddress.lng },
      });
    }
  }

  async handlePaymentProcessed(paymentData, correlationId) {
    logger.info("Payment processed, preparing for delivery", {
      correlationId,
      orderId: paymentData.orderId,
    });

    // Обновляем статус доставки
    await this.redisClient.hSet(`delivery:info:${paymentData.orderId}`, {
      paymentStatus: "paid",
      paymentId: paymentData.paymentId,
      paymentProcessedAt: paymentData.timestamp,
    });
  }

  async handleOrderReadyForDelivery(statusData, correlationId) {
    const orderId = statusData.orderId;

    logger.info("Order ready for delivery, finding courier", {
      correlationId,
      orderId,
    });

    try {
      // Получаем информацию о доставке
      const deliveryInfo = await this.redisClient.hGetAll(
        `delivery:info:${orderId}`
      );

      if (!deliveryInfo || !deliveryInfo.lat || !deliveryInfo.lng) {
        throw new Error("Delivery location not found");
      }

      // Ищем ближайшего курьера
      const nearestCouriers = await this.findNearestCouriers(
        parseFloat(deliveryInfo.lat),
        parseFloat(deliveryInfo.lng),
        5, // радиус 5 км
        5 // максимум 5 курьеров
      );

      if (nearestCouriers.length > 0) {
        // Назначаем первого доступного курьера
        const assignedCourier = await this.assignCourierToOrder(
          orderId,
          nearestCouriers[0].courierId,
          correlationId
        );

        if (assignedCourier) {
          logger.info("Courier assigned successfully", {
            correlationId,
            orderId,
            courierId: nearestCouriers[0].courierId,
          });

          // Обновляем статус в Redis
          await this.redisClient.hSet(`delivery:info:${orderId}`, {
            status: "courier_assigned",
            courierId: nearestCouriers[0].courierId,
            assignedAt: new Date().toISOString(),
          });

          // Удаляем из pending deliveries
          await this.redisClient.zRem("pending-deliveries", orderId);

          // Здесь можно вызвать API для отправки уведомления курьеру
          await this.notifyCourier(nearestCouriers[0].courierId, orderId);
        } else {
          logger.warn("Failed to assign courier", {
            correlationId,
            orderId,
            courierId: nearestCouriers[0].courierId,
          });
        }
      } else {
        logger.warn("No available couriers found nearby", {
          correlationId,
          orderId,
          location: { lat: deliveryInfo.lat, lng: deliveryInfo.lng },
        });

        // Можно добавить логику для расширения радиуса поиска
        await this.redisClient.hSet(`delivery:info:${orderId}`, {
          status: "waiting_for_courier",
          lastSearchAttempt: new Date().toISOString(),
        });
      }
    } catch (error) {
      logger.error("Error handling order ready for delivery", {
        correlationId,
        orderId,
        error: error.message,
      });

      // Обновляем статус с ошибкой
      await this.redisClient.hSet(`delivery:info:${orderId}`, {
        status: "assignment_failed",
        error: error.message,
        failedAt: new Date().toISOString(),
      });
    }
  }

  async findNearestCouriers(lat, lng, radiusKm = 5, limit = 5) {
    try {
      // Ищем курьеров в заданном радиусе
      const courierIds = await this.redisClient.geoSearch(
        "available-couriers",
        { longitude: lng, latitude: lat },
        { radius: radiusKm, unit: "km" }
      );

      // Фильтруем только доступных курьеров
      const availableCouriers = [];

      for (const courierId of courierIds.slice(0, limit)) {
        const courierInfo = await this.redisClient.hGetAll(
          `courier:${courierId}`
        );

        if (courierInfo.status === "available") {
          availableCouriers.push({
            courierId,
            ...courierInfo,
            distance: await this.calculateDistance(
              lat,
              lng,
              parseFloat(courierInfo.lat || lat),
              parseFloat(courierInfo.lng || lng)
            ),
          });
        }
      }

      // Сортируем по расстоянию
      return availableCouriers.sort((a, b) => a.distance - b.distance);
    } catch (error) {
      logger.error("Error finding nearest couriers:", error);
      return [];
    }
  }

  async assignCourierToOrder(orderId, courierId, correlationId) {
    try {
      // Проверяем, доступен ли курьер
      const courierStatus = await this.redisClient.hGet(
        `courier:${courierId}`,
        "status"
      );

      if (courierStatus !== "available") {
        logger.warn("Courier not available", {
          courierId,
          status: courierStatus,
        });
        return false;
      }

      // Обновляем статус курьера
      await this.redisClient.hSet(`courier:${courierId}`, {
        status: "assigned",
        currentOrder: orderId,
        lastAssignment: new Date().toISOString(),
      });

      // Удаляем курьера из гео-индекса (временно)
      await this.redisClient.zRem("available-couriers", courierId);

      // Сохраняем информацию о назначении
      const assignment = {
        orderId,
        courierId,
        assignedAt: new Date().toISOString(),
        estimatedArrival: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // +30 минут
        status: "assigned",
        correlationId,
      };

      await this.redisClient.hSet(`delivery:assignment:${orderId}`, assignment);

      logger.info("Courier assigned to order", {
        correlationId,
        orderId,
        courierId,
        assignment,
      });

      return true;
    } catch (error) {
      logger.error("Error assigning courier:", {
        correlationId,
        orderId,
        courierId,
        error: error.message,
      });
      return false;
    }
  }

  async notifyCourier(courierId, orderId) {
    // Имитация отправки уведомления курьеру
    logger.info("Sending notification to courier", {
      courierId,
      orderId,
      method: "push", // или 'sms', 'in-app'
    });

    // В реальном приложении здесь была бы интеграция с:
    // 1. Firebase Cloud Messaging для push-уведомлений
    // 2. Сервисом SMS
    // 3. WebSocket для real-time обновлений

    return true;
  }

  calculateDistance(lat1, lon1, lat2, lon2) {
    // Упрощенный расчет расстояния (в км)
    const R = 6371; // радиус Земли в км
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  toRad(degrees) {
    return degrees * (Math.PI / 180);
  }

  async close() {
    try {
      if (this.channel) {
        await this.channel.close();
        logger.info("RabbitMQ channel closed");
      }

      if (this.connection) {
        await this.connection.close();
        logger.info("RabbitMQ connection closed");
      }

      if (this.redisClient) {
        await this.redisClient.quit();
        logger.info("Redis connection closed");
      }
    } catch (error) {
      logger.error("Error closing connections:", error);
    }
  }
}

// Запуск consumer
const consumer = new DeliveryConsumer();

// Обработка graceful shutdown
const shutdown = async () => {
  logger.info("Shutting down delivery consumer...");
  await consumer.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Запуск
consumer.initialize().catch((error) => {
  logger.error("Failed to initialize consumer:", error);
  process.exit(1);
});

module.exports = DeliveryConsumer;
