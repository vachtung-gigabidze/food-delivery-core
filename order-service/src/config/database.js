const { Sequelize } = require('sequelize');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'database.log' })
  ]
});

// Создаем экземпляр Sequelize с настройками
const sequelize = new Sequelize(
  process.env.DB_NAME || 'orders_db',
  process.env.DB_USER || 'app',
  process.env.DB_PASSWORD || 'securepass',
  {
    host: process.env.DB_HOST || 'postgres-order',
    port: process.env.DB_PORT || 5432,
    dialect: 'postgres',
    logging: (msg) => logger.debug(msg),
    pool: {
      max: 10,
      min: 0,
      acquire: 30000,
      idle: 10000
    },
    define: {
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at'
    }
  }
);

// Функция для подключения к БД
const connectDatabase = async () => {
  try {
    await sequelize.authenticate();
    logger.info('Подключение к PostgreSQL установлено успешно');
    
    // Синхронизация моделей (в production используем миграции)
    await sequelize.sync({ alter: false });
    logger.info('Модели синхронизированы с БД');
    
    return sequelize;
  } catch (error) {
    logger.error('Ошибка подключения к PostgreSQL:', error);
    
    // Повторная попытка подключения
    logger.info('Повторная попытка подключения через 5 секунд...');
    setTimeout(connectDatabase, 5000);
    
    throw error;
  }
};

// Middleware для транзакций
const transactionMiddleware = () => {
  return async (req, res, next) => {
    req.transaction = await sequelize.transaction();
    
    // Привязываем завершение транзакции к завершению запроса
    const originalSend = res.send;
    res.send = async function(body) {
      try {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          await req.transaction.commit();
          logger.info('Транзакция успешно завершена', {
            correlationId: req.correlationId
          });
        } else {
          await req.transaction.rollback();
          logger.warn('Транзакция откачена из-за ошибки', {
            correlationId: req.correlationId,
            statusCode: res.statusCode
          });
        }
      } catch (error) {
        logger.error('Ошибка при завершении транзакции:', error);
      } finally {
        originalSend.call(this, body);
      }
    };
    
    next();
  };
};

module.exports = { 
  sequelize, 
  connectDatabase, 
  transactionMiddleware,
  Sequelize 
};