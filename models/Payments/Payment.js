const mongoose = require("mongoose");

const PaymentSchema = new mongoose.Schema(
  {
    member: { type: mongoose.Schema.Types.ObjectId, ref: "vendor_tbl" },
    memberId: { type: String, index: true },
    orderId: { type: String, index: true, unique: true },
    cfOrderId: { type: String },
    paymentSessionId: { type: String },
    amount: { type: Number, required: true, set: v => Math.round(v * 10000) / 10000 },
    currency: { type: String, default: "INR" },
    status: {
      type: String,
      enum: [
        // Cashfree order_status values
        "ACTIVE",
        "PAID",
        "EXPIRED",
        "CANCELLED",
        "CREATED",
        "PENDING",
        "FAILED",
        "USER_DROPPED",
        "VOID",
        "PARTIALLY_PAID",
      ],
      default: "CREATED",
    },
    customer: {
      customer_id: { type: String },
      customer_name: { type: String },
      customer_email: { type: String },
      customer_phone: { type: String },
    },
    notifications: [{ type: mongoose.Schema.Types.Mixed }],
    rawResponse: { type: mongoose.Schema.Types.Mixed },
    paymentInfo: { type: mongoose.Schema.Types.Mixed },
    notes: { type: mongoose.Schema.Types.Mixed },

    // Payment verification fields
    verifiedAmount: { type: Number, set: v => Math.round(v * 10000) / 10000 },
    amountMismatch: { type: Boolean, default: false },

    // Webhook tracking
    webhookReceived: { type: Boolean, default: false },
    webhookReceivedAt: { type: Date },

    // Payment method details from Cashfree
    paymentMethod: { type: String },
    bankReference: { type: String },

    // Error tracking
    errorMessage: { type: String },
    errorCode: { type: String },
  },
  { timestamps: true }
);

// Index for faster queries
PaymentSchema.index({ memberId: 1, status: 1 });
PaymentSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Payment", PaymentSchema);


