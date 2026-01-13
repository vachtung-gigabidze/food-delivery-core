const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const winston = require("winston");
const redis = require("redis");
const { v4: uuidv4 } = require("uuid");

// Настройка логгера
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: "delivery-service" },
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "delivery-service.log" }),
  ],
});

// Инициализация Redis для геоданных
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || "redis://redis:6379",
});

redisClient.on("error", (err) => logger.error("Redis Client Error", err));

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

// Middleware для логирования
app.use((req, res, next) => {
  req.correlationId = req.headers["x-correlation-id"] || uuidv4();
  res.setHeader("X-Correlation-ID", req.correlationId);

  logger.info("Request received", {
    correlationId: req.correlationId,
    method: req.method,
    url: req.url,
  });

  next();
});

// Health check
app.get("/health", async (req, res) => {
  const health = {
    status: "healthy",
    service: "delivery-service",
    timestamp: new Date().toISOString(),
    checks: {},
  };

  try {
    await redisClient.ping();
    health.checks.redis = "connected";
  } catch (error) {
    health.status = "unhealthy";
    health.checks.redis = "disconnected";
  }

  res.status(health.status === "healthy" ? 200 : 503).json(health);
});

// Регистрация курьера
app.post("/couriers/register", async (req, res) => {
  try {
    const { courierId, name, phone, location } = req.body;

    if (!courierId || !location || !location.lat || !location.lng) {
      return res.status(400).json({
        error: "Необходимы courierId и location с lat/lng",
      });
    }

    // Сохраняем курьера в Redis (геоданные)
    await redisClient.geoAdd("available-couriers", {
      longitude: location.lng,
      latitude: location.lat,
      member: courierId,
    });

    // Сохраняем метаданные курьера
    await redisClient.hSet(`courier:${courierId}`, {
      name: name || "Unknown",
      phone: phone || "",
      status: "available",
      lastSeen: new Date().toISOString(),
    });

    logger.info("Courier registered", {
      correlationId: req.correlationId,
      courierId,
      location,
    });

    res.json({
      success: true,
      courierId,
      message: "Курьер зарегистрирован",
    });
  } catch (error) {
    logger.error("Error registering courier", {
      correlationId: req.correlationId,
      error: error.message,
    });

    res.status(500).json({
      error: "Ошибка при регистрации курьера",
    });
  }
});

// Поиск ближайших курьеров
app.get("/couriers/nearby", async (req, res) => {
  try {
    const { lat, lng, radius = 5, limit = 10 } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({
        error: "Необходимы параметры lat и lng",
      });
    }

    // Ищем курьеров в радиусе
    const couriers = await redisClient.geoSearch(
      "available-couriers",
      { longitude: parseFloat(lng), latitude: parseFloat(lat) },
      { radius: parseFloat(radius), unit: "km" }
    );

    // Получаем информацию о каждом курьере
    const courierDetails = await Promise.all(
      couriers.slice(0, limit).map(async (courierId) => {
        const details = await redisClient.hGetAll(`courier:${courierId}`);
        return {
          courierId,
          ...details,
        };
      })
    );

    res.json({
      count: courierDetails.length,
      couriers: courierDetails,
      location: { lat: parseFloat(lat), lng: parseFloat(lng) },
      radius: `${radius}km`,
    });
  } catch (error) {
    logger.error("Error finding nearby couriers", {
      correlationId: req.correlationId,
      error: error.message,
    });

    res.status(500).json({
      error: "Ошибка при поиске курьеров",
    });
  }
});

// Назначение курьера на заказ
app.post("/orders/:orderId/assign", async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const { courierId, estimatedArrival } = req.body;

    // Сохраняем назначение в Redis
    const assignment = {
      orderId,
      courierId,
      assignedAt: new Date().toISOString(),
      estimatedArrival:
        estimatedArrival || new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      status: "assigned",
    };

    await redisClient.hSet(`delivery:${orderId}`, assignment);

    // Обновляем статус курьера
    await redisClient.hSet(`courier:${courierId}`, {
      status: "assigned",
      currentOrder: orderId,
    });

    logger.info("Courier assigned to order", {
      correlationId: req.correlationId,
      orderId,
      courierId,
    });

    // Здесь можно отправить событие в RabbitMQ
    // await publishDeliveryAssigned(orderId, courierId, assignment.estimatedArrival);

    res.json({
      success: true,
      assignment,
      message: "Курьер назначен на заказ",
    });
  } catch (error) {
    logger.error("Error assigning courier", {
      correlationId: req.correlationId,
      error: error.message,
    });

    res.status(500).json({
      error: "Ошибка при назначении курьера",
    });
  }
});

// Запуск сервера
async function startServer() {
  try {
    await redisClient.connect();
    logger.info("Redis connected for delivery service");

    const PORT = process.env.PORT || 3002;
    app.listen(PORT, () => {
      logger.info(`Delivery Service запущен на порту ${PORT}`);
    });
  } catch (error) {
    logger.error("Failed to start delivery service:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { app, redisClient };
