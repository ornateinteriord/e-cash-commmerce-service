const mongoose = require("mongoose");

/**
 * Get all Customer Tokens from MongoDB `db.customers` (collection: ornate_auth.customers)
 */
const getCustomerTokens = async (req, res) => {
  try {
    let customers = [];
    const client = mongoose.connection.client;

    // 1. Primary source: ornate_auth database -> customers collection
    if (client) {
      try {
        const dbAuth = client.db("ornate_auth");
        customers = await dbAuth
          .collection("customers")
          .find({})
          .sort({ createdAt: -1 })
          .toArray();
      } catch (err) {
        console.warn("⚠️ Warning querying ornate_auth.customers:", err.message);
      }
    }

    // 2. Fallback to current database (e-cash) -> customers collection if needed
    if (!customers || customers.length === 0) {
      try {
        const currentDb = mongoose.connection.db;
        if (currentDb) {
          customers = await currentDb
            .collection("customers")
            .find({})
            .sort({ createdAt: -1 })
            .toArray();
        }
      } catch (err) {
        console.warn("⚠️ Warning querying current db customers:", err.message);
      }
    }

    // 3. Normalize customer fields for table display
    const formattedCustomers = (customers || []).map((c) => {
      const rawToken = c.token !== undefined && c.token !== null ? c.token : (c.tokens || c.customer_tokens || 0);
      return {
        _id: c._id,
        customerId: c.customerId || c.customer_id || String(c._id),
        name: c.fullName || c.name || "N/A",
        email: c.email || "",
        mobileNumber: c.mobileNumber || c.phone || c.username || "N/A",
        referralCode: c.referralCode || "",
        referralName: c.referralName || "",
        referralType: c.referralType || "customer",
        vendor_id: c.vendor_id || "",
        vendor_name: c.vendor_name || "",
        token: Number(rawToken) || 0,
        tokens: Number(rawToken) || 0,
        customer_tokens: Number(rawToken) || 0,
        level: Number(c.level || 0),
        status: c.isActive !== false ? "Active" : "Inactive",
        isActive: c.isActive !== false,
        totalOrders: Number(c.totalOrders || 0),
        totalSpent: Number(c.totalSpent || 0),
        walletBalance: Number(c.walletBalance || 0),
        createdAt: c.createdAt || new Date()
      };
    });

    return res.status(200).json({
      success: true,
      count: formattedCustomers.length,
      customers: formattedCustomers
    });
  } catch (error) {
    console.error("❌ Error fetching customer tokens:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch customer tokens",
      error: error.message
    });
  }
};

module.exports = {
  getCustomerTokens
};

