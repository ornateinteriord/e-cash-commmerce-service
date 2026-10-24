const LoadFundConfig = require("../../models/Payments/LoadFundConfig");

// Fetch the active configuration
const getLoadFundConfig = async (req, res) => {
  try {
    let config = await LoadFundConfig.findOne();
    if (!config) {
      // Return a default config if nothing exists yet
      config = {
        qr_code_url: "",
        wallet_address: "0x58C50C5E08C7BFCb571E604f9Cf03dB94D3b83B9",
        network_text: "Eshopy-BEP20"
      };
    }
    return res.status(200).json({ success: true, config });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Update configuration (admin flow)
const updateLoadFundConfig = async (req, res) => {
  try {
    const { qr_code_url, wallet_address, network_text } = req.body;

    if (!wallet_address) {
      return res.status(400).json({ success: false, message: "Wallet address is required" });
    }

    let config = await LoadFundConfig.findOne();
    if (config) {
      config.qr_code_url = qr_code_url !== undefined ? qr_code_url : config.qr_code_url;
      config.wallet_address = wallet_address;
      config.network_text = network_text || config.network_text;
      await config.save();
    } else {
      config = new LoadFundConfig({
        qr_code_url,
        wallet_address,
        network_text: network_text || "Eshopy-BEP20"
      });
      await config.save();
    }

    return res.status(200).json({ success: true, message: "Load Fund configuration updated successfully", config });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  getLoadFundConfig,
  updateLoadFundConfig
};
