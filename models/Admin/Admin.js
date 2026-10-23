const mongoose = require("mongoose");

const AdminSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    PASSWORD: { type: String, required: true },
    role: { type: String, required: true },
    STATUS: { type: String, required: true },

    // NIDHI SPECIFIC FIELDS
    password: { type: String }, // Lowercase mapping for Nidhi
    status: { type: String, default: 'active' }, // Lowercase mapping
    reference_id: { type: String, default: null },
    branch_code: { type: String, default: null }
  },
  { timestamps: true, collection: "vendor_admin_tbl" }
);

const AdminModel =
  mongoose.models.vendor_admin_tbl ||
  mongoose.model("vendor_admin_tbl", AdminSchema);

AdminModel.AdminModel = AdminModel;
AdminModel.admin_tbl = AdminModel;
AdminModel.vendor_admin_tbl = AdminModel;

module.exports = AdminModel;
