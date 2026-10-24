const mongoose = require("mongoose");

const LoadFundConfigSchema = new mongoose.Schema(
  {
    qr_code_url: { type: String, default: null },
    wallet_address: { type: String, required: true },
    network_text: { type: String, default: "Eshopy-BEP20" },
  },
  { timestamps: true, collection: "load_fund_config_tbl" }
);

module.exports = mongoose.model("LoadFundConfig", LoadFundConfigSchema);
