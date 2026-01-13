const jwt = require('jsonwebtoken');
const redis = require('redis');

let redisClient;

// Инициализация Redis клиента
const initRedis = async () => {
  redisClient = redis.createClient({ 
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  });
  
  redisClient.on('error', (err) => console.error('Redis Client Error', err));
  await redisClient.connect();
  
  return redisClient;
};

// Middleware аутентификации
const authMiddleware = async (req, res, next) => {
  try {
    // Инициализируем Redis если еще не инициализирован
    if (!redisClient) {
      await initRedis();
    }
    
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Требуется аутентификация',
        code: 'AUTH_REQUIRED'
      });
    }
    
    const token = authHeader.split(' ')[1];
    
    // Валидация JWT токена
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    req.user = decoded;
    
    // Кэширование данных пользователя
    const userCacheKey = `user:${decoded.userId}`;
    const cachedUser = await redisClient.get(userCacheKey);
    
    if (!cachedUser) {
      // Имитация запроса к сервису пользователей
      const userData = {
        id: decoded.userId,
        email: decoded.email || 'user@example.com',
        name: decoded.name || 'Пользователь',
        roles: decoded.roles || ['user']
      };
      
      // Кэшируем на 5 минут
      await redisClient.setEx(
        userCacheKey, 
        300, 
        JSON.stringify(userData)
      );
      req.userData = userData;
    } else {
      req.userData = JSON.parse(cachedUser);
    }
    
    next();
  } catch (error) {
    console.error('Auth error:', error.message);
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        error: 'Неверный токен',
        code: 'INVALID_TOKEN'
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        error: 'Токен истек',
        code: 'TOKEN_EXPIRED'
      });
    }
    
    res.status(500).json({ 
      error: 'Ошибка аутентификации',
      code: 'AUTH_ERROR'
    });
  }
};

// Rate limiting middleware
const createRateLimiter = (windowMs = 15 * 60 * 1000, max = 100) => {
  const requests = new Map();
  
  return (req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    const windowStart = now - windowMs;
    
    // Очистка старых записей
    for (const [key, timestamps] of requests.entries()) {
      requests.set(key, timestamps.filter(time => time > windowStart));
    }
    
    // Получение текущих запросов для IP
    const userRequests = requests.get(ip) || [];
    
    if (userRequests.length >= max) {
      const retryAfter = Math.ceil((userRequests[0] + windowMs - now) / 1000);
      
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        error: 'Слишком много запросов',
        retryAfter: `${retryAfter} секунд`
      });
    }
    
    // Добавляем текущий запрос
    userRequests.push(now);
    requests.set(ip, userRequests);
    
    // Устанавливаем заголовки
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', max - userRequests.length);
    res.setHeader('X-RateLimit-Reset', Math.ceil((now + windowMs) / 1000));
    
    next();
  };
};

module.exports = { 
  authMiddleware, 
  createRateLimiter,
  initRedis 
};