const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const winston = require("winston");
const redis = require("redis");
const { v4: uuidv4 } = require("uuid");
const { connectDatabase, transactionMiddleware } = require("./config/database");
const Order = require("./models/order");
const { getOrderEventPublisher } = require("./events/orderEvents");

// Настройка логгера
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "order-service" },
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

// Инициализация Redis
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || "redis://redis:6379",
});

redisClient.on("error", (err) => logger.error("Redis Client Error", err));
redisClient.on("connect", () => logger.info("Подключение к Redis установлено"));

// Инициализация Express
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware для логирования и correlation ID
app.use((req, res, next) => {
  const correlationId = req.headers["x-correlation-id"] || uuidv4();
  req.correlationId = correlationId;
  res.setHeader("X-Correlation-ID", correlationId);

  logger.info("Incoming request", {
    correlationId,
    method: req.method,
    url: req.url,
    ip: req.ip,
  });

  const start = Date.now();

  const originalSend = res.send;
  res.send = function (body) {
    const duration = Date.now() - start;

    logger.info("Response sent", {
      correlationId,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      contentLength: res.get("Content-Length"),
    });

    originalSend.call(this, body);
  };

  next();
});

// Health check endpoint
app.get("/health", async (req, res) => {
  const healthcheck = {
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "order-service",
    checks: {},
  };

  try {
    // Проверка подключения к PostgreSQL
    const db = await connectDatabase();
    await db.authenticate();
    healthcheck.checks.database = "connected";
  } catch (error) {
    healthcheck.status = "unhealthy";
    healthcheck.checks.database = "disconnected";
    logger.error("Database health check failed", { error: error.message });
  }

  try {
    // Проверка подключения к Redis
    await redisClient.ping();
    healthcheck.checks.redis = "connected";
  } catch (error) {
    healthcheck.status = "unhealthy";
    healthcheck.checks.redis = "disconnected";
    logger.error("Redis health check failed", { error: error.message });
  }

  const statusCode = healthcheck.status === "healthy" ? 200 : 503;
  res.status(statusCode).json(healthcheck);
});

// Создание заказа
app.post("/orders", transactionMiddleware(), async (req, res) => {
  const { transaction } = req;

  try {
    const orderData = req.body;

    logger.info("Creating new order", {
      correlationId: req.correlationId,
      userId: orderData.userId,
      restaurantId: orderData.restaurantId,
    });

    // Валидация данных
    if (
      !orderData.userId ||
      !orderData.restaurantId ||
      !orderData.items ||
      !orderData.deliveryAddress
    ) {
      await transaction.rollback();
      return res.status(400).json({
        error: "Недостаточно данных для создания заказа",
        required: ["userId", "restaurantId", "items", "deliveryAddress"],
      });
    }

    // Создаем заказ в статусе PENDING
    const order = await Order.create(
      {
        userId: orderData.userId,
        restaurantId: orderData.restaurantId,
        totalAmount: orderData.totalAmount,
        deliveryAddress: orderData.deliveryAddress,
        items: orderData.items,
        status: "PENDING",
        paymentStatus: "PENDING",
      },
      { transaction }
    );

    // Кэшируем статус заказа
    await redisClient.setEx(`order:status:${order.id}`, 3600, "PENDING");

    // Получаем publisher и публикуем событие
    const publisher = await getOrderEventPublisher();
    await publisher.publishOrderCreated(order, req.correlationId);

    // Имитация обработки платежа
    const paymentResult = await processPayment(order);

    if (paymentResult.success) {
      // Обновляем статус заказа
      await order.update(
        {
          status: "CONFIRMED",
          paymentStatus: "PAID",
          paymentId: paymentResult.paymentId,
        },
        { transaction }
      );

      // Обновляем кэш
      await redisClient.set(`order:status:${order.id}`, "CONFIRMED");

      // Публикуем событие изменения статуса
      await publisher.publishOrderStatusChanged(
        order.id,
        "PENDING",
        "CONFIRMED",
        req.correlationId
      );

      // Публикуем событие об успешной оплате
      await publisher.publishPaymentProcessed(
        order.id,
        "PAID",
        paymentResult.paymentId,
        req.correlationId
      );

      logger.info("Order created successfully", {
        correlationId: req.correlationId,
        orderId: order.id,
        status: "CONFIRMED",
      });

      res.status(201).json({
        success: true,
        order: order.toJSON(),
        message: "Заказ успешно создан",
      });
    } else {
      // Компенсирующая транзакция - отмена заказа
      await order.update(
        {
          status: "CANCELLED",
          paymentStatus: "FAILED",
        },
        { transaction }
      );

      await redisClient.set(`order:status:${order.id}`, "CANCELLED");

      logger.warn("Order creation failed - payment failed", {
        correlationId: req.correlationId,
        orderId: order.id,
        reason: "Payment failed",
      });

      res.status(402).json({
        error: "Оплата не прошла",
        orderId: order.id,
        status: "CANCELLED",
      });
    }
  } catch (error) {
    await transaction.rollback();

    logger.error("Error creating order", {
      correlationId: req.correlationId,
      error: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      error: "Ошибка при создании заказа",
      message: error.message,
      correlationId: req.correlationId,
    });
  }
});

// Получение информации о заказе
app.get("/orders/:id", async (req, res) => {
  try {
    const orderId = req.params.id;

    // Проверяем кэш Redis
    const cacheKey = `order:${orderId}`;
    const cachedOrder = await redisClient.get(cacheKey);

    if (cachedOrder) {
      logger.debug("Cache hit for order", {
        correlationId: req.correlationId,
        orderId,
        source: "cache",
      });

      return res.json({
        ...JSON.parse(cachedOrder),
        _source: "cache",
      });
    }

    logger.debug("Cache miss for order", {
      correlationId: req.correlationId,
      orderId,
      source: "database",
    });

    // Получаем заказ из БД
    const order = await Order.findByPk(orderId);

    if (!order) {
      return res.status(404).json({
        error: "Заказ не найден",
        orderId,
      });
    }

    const orderJson = order.toJSON();

    // Кэшируем на 5 минут
    await redisClient.setEx(cacheKey, 300, JSON.stringify(orderJson));

    res.json({
      ...orderJson,
      _source: "database",
    });
  } catch (error) {
    logger.error("Error fetching order", {
      correlationId: req.correlationId,
      orderId: req.params.id,
      error: error.message,
    });

    res.status(500).json({
      error: "Ошибка при получении заказа",
      correlationId: req.correlationId,
    });
  }
});

// Получение статуса заказа
app.get("/orders/:id/status", async (req, res) => {
  try {
    const orderId = req.params.id;

    // Сначала проверяем Redis
    const cachedStatus = await redisClient.get(`order:status:${orderId}`);

    if (cachedStatus) {
      return res.json({
        status: cachedStatus,
        source: "cache",
        orderId,
        timestamp: new Date().toISOString(),
      });
    }

    // Если нет в кэше - получаем из БД
    const order = await Order.findByPk(orderId, {
      attributes: ["id", "status", "updated_at"],
    });

    if (!order) {
      return res.status(404).json({
        error: "Заказ не найден",
        orderId,
      });
    }

    // Обновляем кэш
    await redisClient.setEx(`order:status:${orderId}`, 300, order.status);

    res.json({
      status: order.status,
      source: "database",
      orderId,
      lastUpdated: order.updated_at,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Error fetching order status", {
      correlationId: req.correlationId,
      orderId: req.params.id,
      error: error.message,
    });

    res.status(500).json({
      error: "Ошибка при получении статуса заказа",
      correlationId: req.correlationId,
    });
  }
});

// Обновление статуса заказа
app.patch("/orders/:id/status", transactionMiddleware(), async (req, res) => {
  const { transaction } = req;

  try {
    const orderId = req.params.id;
    const { status, reason } = req.body;

    if (!status) {
      await transaction.rollback();
      return res.status(400).json({
        error: "Статус обязателен для обновления",
      });
    }

    const order = await Order.findByPk(orderId, { transaction });

    if (!order) {
      await transaction.rollback();
      return res.status(404).json({
        error: "Заказ не найден",
        orderId,
      });
    }

    const oldStatus = order.status;

    // Проверяем валидность перехода статусов
    if (!isValidStatusTransition(oldStatus, status)) {
      await transaction.rollback();
      return res.status(400).json({
        error: "Недопустимый переход статусов",
        from: oldStatus,
        to: status,
        validTransitions: getValidTransitions(oldStatus),
      });
    }

    // Обновляем статус
    await order.update({ status }, { transaction });

    // Обновляем кэш
    await redisClient.set(`order:status:${orderId}`, status);

    // Инвалидируем кэш полного заказа
    await redisClient.del(`order:${orderId}`);

    // Публикуем событие
    const publisher = await getOrderEventPublisher();
    await publisher.publishOrderStatusChanged(
      orderId,
      oldStatus,
      status,
      req.correlationId
    );

    logger.info("Order status updated", {
      correlationId: req.correlationId,
      orderId,
      oldStatus,
      newStatus: status,
      reason,
    });

    res.json({
      success: true,
      orderId,
      oldStatus,
      newStatus: status,
      updatedAt: order.updated_at,
    });
  } catch (error) {
    await transaction.rollback();

    logger.error("Error updating order status", {
      correlationId: req.correlationId,
      error: error.message,
    });

    res.status(500).json({
      error: "Ошибка при обновлении статуса заказа",
      correlationId: req.correlationId,
    });
  }
});

// Получение заказов пользователя
app.get("/users/:userId/orders", async (req, res) => {
  try {
    const userId = req.params.userId;
    const { limit = 20, offset = 0, status } = req.query;

    const whereClause = { userId };
    if (status) {
      whereClause.status = status;
    }

    const orders = await Order.findAll({
      where: whereClause,
      order: [["created_at", "DESC"]],
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    const total = await Order.count({ where: whereClause });

    res.json({
      orders: orders.map((order) => order.toJSON()),
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + orders.length < total,
      },
    });
  } catch (error) {
    logger.error("Error fetching user orders", {
      correlationId: req.correlationId,
      userId: req.params.userId,
      error: error.message,
    });

    res.status(500).json({
      error: "Ошибка при получении заказов пользователя",
      correlationId: req.correlationId,
    });
  }
});

// Вспомогательные функции
async function processPayment(order) {
  // Имитация обработки платежа
  return new Promise((resolve) => {
    setTimeout(() => {
      const success = Math.random() > 0.1; // 90% успеха

      if (success) {
        resolve({
          success: true,
          paymentId: `pay_${Date.now()}_${Math.random()
            .toString(36)
            .substr(2, 9)}`,
          amount: order.totalAmount,
          processedAt: new Date().toISOString(),
        });
      } else {
        resolve({
          success: false,
          error: "Недостаточно средств",
          code: "INSUFFICIENT_FUNDS",
        });
      }
    }, 1000);
  });
}

function isValidStatusTransition(from, to) {
  const validTransitions = {
    PENDING: ["CONFIRMED", "CANCELLED"],
    CONFIRMED: ["PREPARING", "CANCELLED"],
    PREPARING: ["READY_FOR_DELIVERY", "CANCELLED"],
    READY_FOR_DELIVERY: ["IN_DELIVERY", "CANCELLED"],
    IN_DELIVERY: ["DELIVERED", "CANCELLED"],
    DELIVERED: [],
    CANCELLED: [],
    FAILED: [],
  };

  return validTransitions[from]?.includes(to) || false;
}

function getValidTransitions(status) {
  const transitions = {
    PENDING: ["CONFIRMED", "CANCELLED"],
    CONFIRMED: ["PREPARING", "CANCELLED"],
    PREPARING: ["READY_FOR_DELIVERY", "CANCELLED"],
    READY_FOR_DELIVERY: ["IN_DELIVERY", "CANCELLED"],
    IN_DELIVERY: ["DELIVERED", "CANCELLED"],
    DELIVERED: [],
    CANCELLED: [],
    FAILED: [],
  };

  return transitions[status] || [];
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "Ресурс не найден",
    path: req.url,
    method: req.method,
    correlationId: req.correlationId,
  });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error("Unhandled error", {
    correlationId: req.correlationId,
    error: err.message,
    stack: err.stack,
  });

  res.status(500).json({
    error: "Внутренняя ошибка сервера",
    correlationId: req.correlationId,
    timestamp: new Date().toISOString(),
  });
});

// Функция инициализации сервиса
async function initializeService() {
  try {
    // Подключаемся к БД
    await connectDatabase();
    logger.info("Database connection established");

    // Подключаемся к Redis
    await redisClient.connect();
    logger.info("Redis connection established");

    // Запускаем сервер
    const PORT = process.env.PORT || 3001;
    const server = app.listen(PORT, () => {
      logger.info(`Order Service запущен на порту ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || "development"}`);
    });

    // Graceful shutdown
    const shutdown = async () => {
      logger.info("Получен сигнал завершения работы...");

      // Закрываем сервер
      server.close(async () => {
        logger.info("HTTP сервер закрыт");

        // Закрываем соединения
        await redisClient.quit();
        logger.info("Redis соединение закрыто");

        process.exit(0);
      });

      // Таймаут для принудительного завершения
      setTimeout(() => {
        logger.error("Принудительное завершение работы");
        process.exit(1);
      }, 10000);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (error) {
    logger.error("Failed to initialize service:", error);
    process.exit(1);
  }
}

// Запуск сервиса
if (require.main === module) {
  initializeService().catch((error) => {
    console.error("Failed to start service:", error);
    process.exit(1);
  });
}

module.exports = { app, initializeService };
