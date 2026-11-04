const mongoose = require("mongoose");

const commissionSchema = new mongoose.Schema(
    {
        commission_id: {
            type: String,
            required: true,
            unique: true,
        },
        // Beneficiary (Person receiving commission - the introducer)
        beneficiary_id: {
            type: String,
            required: true,
            index: true,
        },
        beneficiary_name: {
            type: String,
            required: true,
        },
        beneficiary_type: {
            type: String,
            enum: ["MEMBER", "AGENT"],
            required: true,
        },
        // Source (Person who generated the commission)
        source_id: {
            type: String,
            required: true,
            index: true,
        },
        source_name: {
            type: String,
            required: true,
        },
        source_type: {
            type: String,
            enum: ["MEMBER", "AGENT", "ADMIN"],
            required: true,
        },
        // Transaction Details
        transaction_id: {
            type: String,
            required: true,
        },
        transaction_date: {
            type: Date,
            default: Date.now,
        },
        account_type: {
            type: String,
            required: true, // FD, RD, Pigmy
        },
        account_type_id: {
            type: String,
            default: null, // 1, 2, 3
        },
        transaction_amount: {
            type: Number,
            required: true,
            set: v => Math.round(v * 10000) / 10000
        },
        // Commission Calculation
        commission_rate: {
            type: Number,
            required: true, // Percentage (e.g., 4.50 for 4.50%)
        },
        commission_amount: {
            type: Number,
            required: true,
            set: v => Math.round(v * 10000) / 10000
        },
        level: {
            type: Number,
            required: true,
            min: 1,
            max: 50, // Supports up to 20 levels (and beyond)
        },
        // Status Tracking
        status: {
            type: String,
            enum: ["PENDING", "CREDITED", "FAILED", "WITHDRAWN"],
            default: "PENDING",
        },
        credited_at: {
            type: Date,
            default: null,
        },
        failure_reason: {
            type: String,
            default: null,
        },
        // Additional Info
        notes: {
            type: String,
            default: null,
        },
    },
    { timestamps: true, collection: "commission_tbl" }
);

// Indexes for better query performance
commissionSchema.index({ beneficiary_id: 1, status: 1 });
commissionSchema.index({ source_id: 1, transaction_date: -1 });
commissionSchema.index({ transaction_id: 1 });
commissionSchema.index({ createdAt: -1 });

const CommissionModel = mongoose.model("Commission", commissionSchema);
module.exports = CommissionModel;
