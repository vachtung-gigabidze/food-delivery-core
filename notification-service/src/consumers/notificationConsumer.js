const amqplib = require("amqplib");
const winston = require("winston");
const nodemailer = require("nodemailer");
const { v4: uuidv4 } = require("uuid");

// Настройка логгера
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: "notification-service" },
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "notification-service.log" }),
  ],
});

class NotificationConsumer {
  constructor() {
    this.connection = null;
    this.channel = null;
    this.transporter = null;
    this.maxRetries = 3;

    // Инициализация email транспортера
    this.initEmailTransporter();
  }

  initEmailTransporter() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: process.env.SMTP_PORT || 587,
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  async initialize() {
    try {
      await this.connectToRabbitMQ();
      logger.info("Notification service initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize notification service:", error);
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

      // Создаем очередь для уведомлений
      const queueResult = await this.channel.assertQueue(
        "notification-service-queue",
        {
          durable: true,
        //   arguments: {
        //     "x-dead-letter-exchange": "order-events-dlx",
        //     "x-dead-letter-routing-key": "notification.dead-letter",
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
      await this.channel.bindQueue(
        queueResult.queue,
        "order-events",
        "order.delivery.assigned"
      );

      // Создаем DLQ
      // await this.channel.assertQueue("notification-service-dlq", {
      //   durable: true,
      // });
      // await this.channel.bindQueue(
      //   "notification-service-dlq",
      //   "order-events-dlx",
      //   "notification.dead-letter"
      // );

      logger.info("Connected to RabbitMQ for notifications");

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
              const correlationId =
                event.correlationId || `notif_${Date.now()}`;

              logger.info("Notification event received", {
                correlationId,
                type: event.type,
                routingKey: message.fields.routingKey,
              });

              // Обработка события
              await this.handleNotification(event, correlationId);

              // Подтверждаем обработку
              this.channel.ack(message);
            } catch (error) {
              logger.error("Error processing notification:", {
                error: error.message,
                content: message.content.toString(),
              });

              // Логика повторных попыток
              const headers = message.properties.headers || {};
              const retryCount = headers["x-retry-count"] || 0;

              if (retryCount < this.maxRetries) {
                headers["x-retry-count"] = retryCount + 1;
                this.channel.nack(message, false, false);

                await new Promise((resolve) =>
                  setTimeout(resolve, 1000 * Math.pow(2, retryCount))
                );
              } else {
                this.channel.nack(message, false, false);
                logger.warn("Notification sent to DLQ");
              }
            }
          }
        },
        {
          noAck: false,
          consumerTag: "notification-service-consumer",
        }
      );

      logger.info("Started consuming notification messages");
    } catch (error) {
      logger.error("Error starting notification consumer:", error);
      throw error;
    }
  }

  async handleNotification(event, correlationId) {
    const { type, data } = event;

    switch (type) {
      case "ORDER_CREATED":
        await this.sendOrderCreatedNotifications(data, correlationId);
        break;

      case "ORDER_STATUS_CHANGED":
        await this.sendOrderStatusNotifications(data, correlationId);
        break;

      case "PAYMENT_PROCESSED":
        await this.sendPaymentNotifications(data, correlationId);
        break;

      case "DELIVERY_ASSIGNED":
        await this.sendDeliveryNotifications(data, correlationId);
        break;

      default:
        logger.debug("Unhandled notification type:", type);
    }
  }

  async sendOrderCreatedNotifications(orderData, correlationId) {
    logger.info("Sending order created notifications", {
      correlationId,
      orderId: orderData.orderId,
      userId: orderData.userId,
    });

    const notifications = [
      // Уведомление пользователю
      this.sendEmail(
        {
          to: this.getUserEmail(orderData.userId),
          subject: "Ваш заказ создан",
          text: `Ваш заказ #${orderData.orderId} успешно создан. Сумма: ${orderData.totalAmount} руб.`,
          html: this.generateOrderCreatedHtml(orderData),
        },
        correlationId
      ),

      // Уведомление ресторану (в реальном приложении)
      // this.sendPushNotification('restaurant', orderData.restaurantId, {
      //   title: 'Новый заказ',
      //   body: `Поступил новый заказ #${orderData.orderId}`
      // }, correlationId)
    ];

    await Promise.allSettled(notifications);
  }

  async sendOrderStatusNotifications(statusData, correlationId) {
    logger.info("Sending order status notifications", {
      correlationId,
      orderId: statusData.orderId,
      newStatus: statusData.newStatus,
    });

    const statusMessages = {
      CONFIRMED: "подтвержден",
      PREPARING: "начали готовить",
      READY_FOR_DELIVERY: "готов к доставке",
      IN_DELIVERY: "в пути к вам",
      DELIVERED: "доставлен",
      CANCELLED: "отменен",
    };

    const message = statusMessages[statusData.newStatus];
    if (!message) return;

    // Получаем информацию о пользователе (в реальном приложении из БД)
    const userEmail = this.getUserEmail("default-user");

    await this.sendEmail(
      {
        to: userEmail,
        subject: `Статус заказа #${statusData.orderId} изменен`,
        text: `Статус вашего заказа изменен: ${message}.`,
        html: this.generateStatusChangedHtml(statusData, message),
      },
      correlationId
    );

    // Также можно отправить push-уведомление
    // await this.sendPushNotification('user', userId, {
    //   title: 'Статус заказа изменен',
    //   body: `Ваш заказ ${message}`
    // }, correlationId);
  }

  async sendPaymentNotifications(paymentData, correlationId) {
    if (paymentData.paymentStatus === "PAID") {
      logger.info("Sending payment success notifications", {
        correlationId,
        orderId: paymentData.orderId,
      });

      const userEmail = this.getUserEmail("default-user");

      await this.sendEmail(
        {
          to: userEmail,
          subject: `Оплата заказа #${paymentData.orderId} прошла успешно`,
          text: `Оплата заказа #${paymentData.orderId} на сумму ... успешно проведена.`,
          html: this.generatePaymentSuccessHtml(paymentData),
        },
        correlationId
      );
    }
  }

  async sendDeliveryNotifications(deliveryData, correlationId) {
    logger.info("Sending delivery assigned notifications", {
      correlationId,
      orderId: deliveryData.orderId,
      courierId: deliveryData.courierId,
    });

    // Уведомление пользователю
    const userEmail = this.getUserEmail("default-user");

    await this.sendEmail(
      {
        to: userEmail,
        subject: `Курьер назначен на ваш заказ #${deliveryData.orderId}`,
        text: `Курьер назначен на ваш заказ. Примерное время прибытия: ${new Date(
          deliveryData.estimatedArrival
        ).toLocaleTimeString()}`,
        html: this.generateDeliveryAssignedHtml(deliveryData),
      },
      correlationId
    );

    // Уведомление курьеру (в реальном приложении - push/SMS)
    // await this.sendSMSToCourier(deliveryData.courierId,
    //   `Новый заказ #${deliveryData.orderId}. Подробности в приложении.`
    // );
  }

  async sendEmail(emailOptions, correlationId) {
    try {
      // В демо-версии логируем вместо реальной отправки
      if (process.env.NODE_ENV === "development" || !process.env.SMTP_USER) {
        logger.info("Email would be sent (development mode):", {
          correlationId,
          to: emailOptions.to,
          subject: emailOptions.subject,
        });
        return { success: true, mode: "development" };
      }

      const mailOptions = {
        from: process.env.SMTP_FROM || "noreply@fooddelivery.com",
        ...emailOptions,
      };

      const info = await this.transporter.sendMail(mailOptions);

      logger.info("Email sent successfully", {
        correlationId,
        messageId: info.messageId,
        to: emailOptions.to,
      });

      return { success: true, messageId: info.messageId };
    } catch (error) {
      logger.error("Failed to send email:", {
        correlationId,
        error: error.message,
        to: emailOptions.to,
      });

      return { success: false, error: error.message };
    }
  }

  // Вспомогательные методы для генерации контента
  getUserEmail(userId) {
    // В реальном приложении - запрос к сервису пользователей
    return process.env.TEST_EMAIL || "test@example.com";
  }

  generateOrderCreatedHtml(orderData) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Ваш заказ создан!</h2>
        <p>Номер заказа: <strong>${orderData.orderId}</strong></p>
        <p>Сумма: <strong>${orderData.totalAmount} руб.</strong></p>
        <p>Адрес доставки: ${orderData.deliveryAddress.address}</p>
        <p>Примерное время доставки: ${new Date(
          orderData.estimatedDeliveryTime
        ).toLocaleTimeString()}</p>
        <hr>
        <p>Спасибо, что выбрали наш сервис!</p>
      </div>
    `;
  }

  generateStatusChangedHtml(statusData, message) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Статус заказа изменен</h2>
        <p>Заказ #${statusData.orderId} <strong>${message}</strong></p>
        <p>Время изменения: ${new Date(
          statusData.timestamp
        ).toLocaleString()}</p>
        <hr>
        <p>Вы можете отслеживать статус заказа в нашем приложении.</p>
      </div>
    `;
  }

  generatePaymentSuccessHtml(paymentData) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Оплата прошла успешно!</h2>
        <p>Заказ #${paymentData.orderId} оплачен.</p>
        <p>ID платежа: ${paymentData.paymentId}</p>
        <p>Время оплаты: ${new Date(paymentData.timestamp).toLocaleString()}</p>
        <hr>
        <p>Спасибо за оплату!</p>
      </div>
    `;
  }

  generateDeliveryAssignedHtml(deliveryData) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Курьер назначен!</h2>
        <p>На ваш заказ #${deliveryData.orderId} назначен курьер.</p>
        <p>ID курьера: ${deliveryData.courierId}</p>
        <p>Примерное время прибытия: ${new Date(
          deliveryData.estimatedArrival
        ).toLocaleTimeString()}</p>
        <hr>
        <p>Курьер свяжется с вами по прибытии.</p>
      </div>
    `;
  }

  async close() {
    try {
      if (this.channel) {
        await this.channel.close();
      }

      if (this.connection) {
        await this.connection.close();
      }

      logger.info("Notification service connections closed");
    } catch (error) {
      logger.error("Error closing notification service:", error);
    }
  }
}

// Запуск сервиса
const consumer = new NotificationConsumer();

const shutdown = async () => {
  logger.info("Shutting down notification service...");
  await consumer.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

consumer.initialize().catch((error) => {
  logger.error("Failed to start notification service:", error);
  process.exit(1);
});

module.exports = NotificationConsumer;
