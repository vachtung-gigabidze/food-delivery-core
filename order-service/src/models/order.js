const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/database");
const { v4: uuidv4 } = require("uuid");

const Order = sequelize.define(
  "Order",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "user_id",
    },
    restaurantId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "restaurant_id",
    },
    status: {
      type: DataTypes.ENUM(
        "PENDING",
        "CONFIRMED",
        "PREPARING",
        "READY_FOR_DELIVERY",
        "IN_DELIVERY",
        "DELIVERED",
        "CANCELLED",
        "FAILED"
      ),
      defaultValue: "PENDING",
      allowNull: false,
      validate: {
        isIn: [
          [
            "PENDING",
            "CONFIRMED",
            "PREPARING",
            "READY_FOR_DELIVERY",
            "IN_DELIVERY",
            "DELIVERED",
            "CANCELLED",
            "FAILED",
          ],
        ],
      },
    },
    totalAmount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      field: "total_amount",
      validate: {
        min: 0,
      },
    },
    deliveryAddress: {
      type: DataTypes.JSONB,
      allowNull: false,
      field: "delivery_address",
      validate: {
        isValidAddress(value) {
          if (!value.address || !value.lat || !value.lng) {
            throw new Error(
              "Delivery address must contain address, lat, and lng"
            );
          }
        },
      },
    },
    items: {
      type: DataTypes.JSONB,
      allowNull: false,
      validate: {
        isValidItems(value) {
          if (!Array.isArray(value) || value.length === 0) {
            throw new Error("Items must be a non-empty array");
          }

          for (const item of value) {
            if (!item.itemId || !item.quantity || !item.price) {
              throw new Error(
                "Each item must have itemId, quantity, and price"
              );
            }
          }
        },
      },
    },
    paymentStatus: {
      type: DataTypes.ENUM("PENDING", "PAID", "FAILED", "REFUNDED"),
      defaultValue: "PENDING",
      field: "payment_status",
    },
    paymentId: {
      type: DataTypes.STRING,
      field: "payment_id",
    },
    notes: {
      type: DataTypes.TEXT,
    },
    estimatedDeliveryTime: {
      type: DataTypes.DATE,
      field: "estimated_delivery_time",
    },
    actualDeliveryTime: {
      type: DataTypes.DATE,
      field: "actual_delivery_time",
    },
  },
  {
    tableName: "orders",
    timestamps: true,
    underscored: true,

    // Хуки
    hooks: {
      beforeCreate: (order) => {
        if (!order.estimatedDeliveryTime) {
          // Устанавливаем время доставки на 45 минут вперед
          order.estimatedDeliveryTime = new Date(Date.now() + 45 * 60 * 1000);
        }
      },

      afterUpdate: async (order) => {
        // При доставке заказа устанавливаем actualDeliveryTime
        if (order.status === "DELIVERED" && !order.actualDeliveryTime) {
          order.actualDeliveryTime = new Date();
          await order.save({ hooks: false });
        }
      },
    },
  }
);

// Статические методы
Order.findByUserId = function (userId, options = {}) {
  return this.findAll({
    where: { userId },
    order: [["created_at", "DESC"]],
    limit: options.limit || 50,
    offset: options.offset || 0,
    ...options,
  });
};

Order.findByRestaurantId = function (restaurantId, options = {}) {
  return this.findAll({
    where: { restaurantId },
    order: [["created_at", "DESC"]],
    ...options,
  });
};

Order.findByStatus = function (status, options = {}) {
  return this.findAll({
    where: { status },
    order: [["created_at", "ASC"]],
    ...options,
  });
};

// Методы экземпляра
Order.prototype.toJSON = function () {
  const values = Object.assign({}, this.get());

  // Преобразуем Decimal в число для JSON
  if (values.totalAmount) {
    values.totalAmount = parseFloat(values.totalAmount);
  }

  // Добавляем вычисляемые поля
  values.isActive = !["DELIVERED", "CANCELLED", "FAILED"].includes(
    values.status
  );
  values.timeUntilDelivery = values.estimatedDeliveryTime
    ? Math.max(
        0,
        Math.floor(
          (new Date(values.estimatedDeliveryTime) - new Date()) / (60 * 1000)
        )
      )
    : null;

  return values;
};

// Валидационные методы
Order.prototype.canBeCancelled = function () {
  return ["PENDING", "CONFIRMED", "PREPARING"].includes(this.status);
};

Order.prototype.canBeUpdated = function () {
  return this.status !== "DELIVERED" && this.status !== "CANCELLED";
};

module.exports = Order;
