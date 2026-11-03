const mongoose = require("mongoose");
const moment = require("moment");

const LevelRoiScheduleSchema = new mongoose.Schema(
  {
    schedule_id: { type: String, required: true, unique: true },
    sponsor_id: { type: String, required: true, index: true },
    sponsor_name: { type: String },
    sponsor_level: { type: Number, default: 0 },
    level: { type: Number, required: true }, // 1 to 7
    from_member_id: { type: String, required: true, index: true },
    from_member_name: { type: String },
    package_amount: { type: Number, required: true },
    total_percentage: { type: Number, required: true }, // e.g. 10, 3, 2, 1, 1, 1, 1
    total_amount: { type: Number, required: true }, // package_amount * total_percentage / 100
    daily_amount: { type: Number, required: true }, // total_amount / 100
    target_days: { type: Number, default: 100 },
    payout_count: { type: Number, default: 0 },
    total_paid: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["Active", "Completed", "Paused"],
      default: "Active",
      index: true
    },
    start_date: {
      type: String,
      default: () => moment().utcOffset("+05:30").format("YYYY-MM-DD")
    },
    last_payout_date: { type: String, default: null }
  },
  { timestamps: true, collection: "level_roi_schedules" }
);

module.exports = mongoose.model("LevelRoiSchedule", LevelRoiScheduleSchema);
