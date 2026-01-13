const { Sequelize } = require('sequelize');

async function runMigration() {
  // Подключение к БД
  const sequelize = new Sequelize(
    process.env.DB_NAME || 'orders_db',
    process.env.DB_USER || 'app',
    process.env.DB_PASSWORD || 'securepass',
    {
      host: process.env.DB_HOST || 'postgres-order',
      port: process.env.DB_PORT || 5432,
      dialect: 'postgres',
      logging: console.log
    }
  );
  
  try {
    await sequelize.authenticate();
    console.log('Подключение к БД установлено для миграции');
    
    // Создание таблицы orders
    const query = `
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        restaurant_id UUID NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
        total_amount DECIMAL(10,2) NOT NULL,
        delivery_address JSONB NOT NULL,
        items JSONB NOT NULL,
        payment_status VARCHAR(50) DEFAULT 'PENDING',
        payment_id VARCHAR(255),
        notes TEXT,
        estimated_delivery_time TIMESTAMP,
        actual_delivery_time TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        -- Индексы для быстрого поиска
        INDEX idx_user_id (user_id),
        INDEX idx_restaurant_id (restaurant_id),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at)
      );
      
      -- Таблица для аудита изменений статусов
      CREATE TABLE IF NOT EXISTS order_status_history (
        id SERIAL PRIMARY KEY,
        order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        old_status VARCHAR(50),
        new_status VARCHAR(50) NOT NULL,
        changed_by VARCHAR(255),
        change_reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        INDEX idx_order_id (order_id),
        INDEX idx_created_at (created_at)
      );
      
      -- Триггер для автоматического обновления updated_at
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ language 'plpgsql';
      
      DROP TRIGGER IF EXISTS update_orders_updated_at ON orders;
      CREATE TRIGGER update_orders_updated_at
        BEFORE UPDATE ON orders
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
      
      -- Функция для записи истории статусов
      CREATE OR REPLACE FUNCTION log_order_status_change()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD.status IS DISTINCT FROM NEW.status THEN
          INSERT INTO order_status_history 
            (order_id, old_status, new_status, changed_by)
          VALUES 
            (NEW.id, OLD.status, NEW.status, current_user);
        END IF;
        RETURN NEW;
      END;
      $$ language 'plpgsql';
      
      DROP TRIGGER IF EXISTS log_order_status_trigger ON orders;
      CREATE TRIGGER log_order_status_trigger
        AFTER UPDATE ON orders
        FOR EACH ROW
        EXECUTE FUNCTION log_order_status_change();
    `;
    
    await sequelize.query(query);
    console.log('Миграция успешно выполнена');
    
    // Создание тестовых данных (для разработки)
    if (process.env.NODE_ENV === 'development') {
      await sequelize.query(`
        INSERT INTO orders (id, user_id, restaurant_id, status, total_amount, delivery_address, items)
        VALUES 
          ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'DELIVERED', 1500.00, '{"address": "ул. Примерная, д. 1", "lat": 55.7558, "lng": 37.6176}', '[{"itemId": "pizza-1", "name": "Пепперони", "quantity": 2, "price": 750}]'),
          ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', '55555555-5555-5555-5555-555555555555', 'PREPARING', 890.50, '{"address": "пр. Тестовый, д. 10", "lat": 55.7517, "lng": 37.6178}', '[{"itemId": "burger-1", "name": "Чизбургер", "quantity": 1, "price": 890.50}]')
        ON CONFLICT (id) DO NOTHING;
      `);
      console.log('Тестовые данные созданы');
    }
    
  } catch (error) {
    console.error('Ошибка при выполнении миграции:', error);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

// Запуск миграции
if (require.main === module) {
  runMigration().then(() => {
    console.log('Миграция завершена');
    process.exit(0);
  }).catch(error => {
    console.error('Миграция завершилась с ошибкой:', error);
    process.exit(1);
  });
}

module.exports = runMigration;