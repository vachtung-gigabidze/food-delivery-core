const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const axios = require("axios");
const {
  authMiddleware,
  createRateLimiter,
  initRedis,
} = require("./middleware/auth");
const winston = require("winston");

// Настройка логгера
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

const app = express();

// Middleware
app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Логирование запросов
app.use((req, res, next) => {
  const start = Date.now();
  const correlationId =
    req.headers["x-correlation-id"] ||
    `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  req.correlationId = correlationId;
  res.setHeader("X-Correlation-ID", correlationId);

  logger.info("Incoming request", {
    correlationId,
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.get("User-Agent"),
  });

  // Логирование ответа
  const originalSend = res.send;
  res.send = function (body) {
    const duration = Date.now() - start;

    logger.info("Response sent", {
      correlationId,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      contentLength: res.get("Content-Length") || 0,
    });

    originalSend.call(this, body);
  };

  next();
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "api-gateway",
    version: "1.0.0",
  });
});

// Rate limiting для разных endpoint'ов
app.use("/api/auth", createRateLimiter(15 * 60 * 1000, 10)); // 10 запросов за 15 минут
app.use("/api/orders", createRateLimiter(60 * 1000, 30)); // 30 запросов в минуту
app.use("/api", createRateLimiter(60 * 1000, 100)); // 100 запросов в минуту для остального API

// Генерация тестового JWT токена (для демонстрации)
app.post("/api/auth/token", (req, res) => {
  const jwt = require("jsonwebtoken");
  const { userId = "user-123", email = "test@example.com" } = req.body;

  const token = jwt.sign(
    {
      userId,
      email,
      name: "Тестовый Пользователь",
      roles: ["user"],
    },
    process.env.JWT_SECRET || "your-secret-key",
    { expiresIn: "24h" }
  );

  res.json({ token, expiresIn: "24h" });
});

// Проксирование запросов к сервису заказов
app.use("/api/orders", authMiddleware);

app.post("/api/orders", async (req, res) => {
  try {
    logger.info("Creating order", {
      correlationId: req.correlationId,
      userId: req.user.userId,
    });

    const orderData = {
      ...req.body,
      userId: req.user.userId,
      correlationId: req.correlationId,
    };

    // Проксируем в сервис заказов
    const response = await axios.post(
      `${process.env.ORDER_SERVICE_URL || "http://order-service:3001"}/orders`,
      orderData,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Correlation-ID": req.correlationId,
        },
        timeout: 10000, // 10 секунд таймаут
      }
    );

    res.status(response.status).json(response.data);
  } catch (error) {
    logger.error("Order creation failed", {
      correlationId: req.correlationId,
      error: error.message,
      stack: error.stack,
    });

    if (error.response) {
      // Сервис заказов вернул ошибку
      res.status(error.response.status).json(error.response.data);
    } else if (error.request) {
      // Запрос был сделан, но ответ не получен
      res.status(503).json({
        error: "Сервис заказов временно недоступен",
        code: "ORDER_SERVICE_UNAVAILABLE",
      });
    } else {
      // Ошибка настройки запроса
      res.status(500).json({
        error: "Внутренняя ошибка сервера",
        code: "INTERNAL_SERVER_ERROR",
      });
    }
  }
});

app.get("/api/orders/:id", async (req, res) => {
  try {
    const orderId = req.params.id;
    const cacheKey = `order:${orderId}`;

    // Инициализируем Redis если нужно
    const redisClient = await initRedis();

    // Проверяем кэш
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
      source: "service",
    });

    // Запрашиваем у сервиса заказов
    const response = await axios.get(
      `${
        process.env.ORDER_SERVICE_URL || "http://order-service:3001"
      }/orders/${orderId}`,
      {
        headers: {
          "X-Correlation-ID": req.correlationId,
          "X-User-ID": req.user.userId,
        },
      }
    );

    const order = response.data;

    // Кэшируем заказ на 60 секунд
    await redisClient.setEx(cacheKey, 60, JSON.stringify(order));

    res.json({
      ...order,
      _source: "database",
    });
  } catch (error) {
    logger.error("Failed to get order", {
      correlationId: req.correlationId,
      orderId: req.params.id,
      error: error.message,
    });

    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      res.status(500).json({
        error: "Ошибка при получении заказа",
        code: "ORDER_FETCH_ERROR",
      });
    }
  }
});

// Получение статуса заказа
app.get("/api/orders/:id/status", async (req, res) => {
  try {
    const orderId = req.params.id;
    const redisClient = await initRedis();
    const cacheKey = `order:status:${orderId}`;

    const cachedStatus = await redisClient.get(cacheKey);
    if (cachedStatus) {
      return res.json({
        status: cachedStatus,
        source: "cache",
        orderId,
      });
    }

    const response = await axios.get(
      `${
        process.env.ORDER_SERVICE_URL || "http://order-service:3001"
      }/orders/${orderId}/status`
    );

    res.json(response.data);
  } catch (error) {
    logger.error("Failed to get order status", {
      correlationId: req.correlationId,
      orderId: req.params.id,
      error: error.message,
    });

    res.status(500).json({
      error: "Ошибка при получении статуса заказа",
      code: "STATUS_FETCH_ERROR",
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "Ресурс не найден",
    path: req.url,
    method: req.method,
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

// Запуск сервера
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
  await initRedis();
  logger.info(`API Gateway запущен на порту ${PORT}`);
  logger.info(
    `Подключен к Redis: ${process.env.REDIS_URL || "redis://localhost:6379"}`
  );
});

// Graceful shutdown
const shutdown = async () => {
  logger.info("Получен сигнал завершения работы...");

  server.close(async () => {
    logger.info("HTTP сервер закрыт");
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

module.exports = { app, server };
