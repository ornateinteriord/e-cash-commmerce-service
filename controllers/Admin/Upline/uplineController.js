const mongoose = require("mongoose");
const MemberModel = require("../../../models/Users/Member");

/**
 * Traverses upline sponsors for a vendor in MemberModel (vendor_tbl)
 */
const findVendorUplines = async (startIdentifier, maxLevels = 20) => {
  const uplines = [];
  const visited = new Set();
  let currentId = String(startIdentifier).trim();

  let level = 1;
  while (level <= maxLevels) {
    const currentVendor = await MemberModel.findOne({
      $or: [
        { Member_id: currentId },
        { member_id: currentId },
        { member_code: currentId },
        { mobileno: currentId }
      ]
    });

    if (!currentVendor) break;

    const sponsorIdentifier = currentVendor.sponsor_id || currentVendor.Sponsor_code || currentVendor.introducer;
    if (!sponsorIdentifier || String(sponsorIdentifier) === String(currentId)) {
      break;
    }

    const sponsor = await MemberModel.findOne({
      $or: [
        { Member_id: sponsorIdentifier },
        { member_id: sponsorIdentifier },
        { member_code: sponsorIdentifier },
        { mobileno: sponsorIdentifier }
      ]
    });

    if (!sponsor) {
      // Direct raw record fallback
      uplines.push({
        level: level++,
        id: sponsorIdentifier,
        member_code: sponsorIdentifier,
        name: currentVendor.Sponsor_name || "Sponsor",
        mobile: sponsorIdentifier,
        email: "-",
        type: "Vendor",
        token: 0,
        rank_level: 0,
        status: "Active"
      });
      break;
    }

    const actualSponsorId = String(sponsor.Member_id || sponsor.member_id || sponsor.member_code);
    if (visited.has(actualSponsorId)) {
      break; // Circular reference guard
    }
    visited.add(actualSponsorId);

    const rawToken = sponsor.token !== undefined && sponsor.token !== null ? sponsor.token : (sponsor.tokens || 0);

    uplines.push({
      level: level++,
      id: sponsor.Member_id || sponsor.member_id || sponsor._id,
      member_code: sponsor.member_code || sponsor.Member_id || "-",
      name: sponsor.Name || sponsor.name || "Vendor",
      mobile: sponsor.mobileno || sponsor.contactno || "-",
      email: sponsor.email || "-",
      type: "Vendor",
      token: Number(rawToken) || 0,
      rank_level: Number(sponsor.level || 0),
      status: sponsor.status || "Active",
      date_joined: sponsor.Date_of_joining || sponsor.createdAt
    });

    currentId = actualSponsorId;
  }

  return uplines;
};

/**
 * GET /admin/upline-tree/vendor/:id
 * Returns complete upline sponsor hierarchy for a Vendor
 */
const getVendorUplines = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: "Vendor ID is required" });
    }

    const targetVendor = await MemberModel.findOne({
      $or: [
        { Member_id: id },
        { member_id: id },
        { member_code: id },
        { mobileno: id },
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])
      ]
    });

    const uplines = await findVendorUplines(id, 20);

    return res.status(200).json({
      success: true,
      target: targetVendor ? {
        id: targetVendor.Member_id || targetVendor.member_id,
        member_code: targetVendor.member_code || targetVendor.Member_id,
        name: targetVendor.Name || targetVendor.name,
        mobile: targetVendor.mobileno || targetVendor.contactno,
        email: targetVendor.email,
        token: Number(targetVendor.token || targetVendor.tokens || 0),
        status: targetVendor.status || "Active"
      } : { id },
      count: uplines.length,
      uplines
    });
  } catch (error) {
    console.error("❌ Error fetching vendor uplines:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch vendor uplines",
      error: error.message
    });
  }
};

/**
 * GET /admin/upline-tree/customer/:id
 * Returns complete upline hierarchy for a Customer (Customers + Vendor chain)
 */
const getCustomerUplines = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: "Customer ID is required" });
    }

    const client = mongoose.connection.client;
    let custCol = null;

    if (client) {
      try {
        custCol = client.db("ornate_auth").collection("customers");
      } catch (e) {
        // Fallback
      }
    }
    if (!custCol && mongoose.connection.db) {
      custCol = mongoose.connection.db.collection("customers");
    }

    if (!custCol) {
      return res.status(500).json({ success: false, message: "Customer collection not available" });
    }

    const targetCustomer = await custCol.findOne({
      $or: [
        { customerId: id },
        { customer_id: id },
        { mobileNumber: id },
        { phone: id },
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: new mongoose.Types.ObjectId(id) }] : [])
      ]
    });

    const uplines = [];
    const visited = new Set();
    let currentId = id;
    let level = 1;
    let reachedVendorCode = null;

    // 1. Traverse Customer Referral Tree
    while (level <= 20) {
      const cust = await custCol.findOne({
        $or: [
          { customerId: currentId },
          { customer_id: currentId },
          { mobileNumber: currentId },
          { phone: currentId }
        ]
      });

      if (!cust) break;
      const refCode = cust.referralCode;
      if (!refCode || visited.has(refCode) || refCode === currentId) break;
      visited.add(refCode);

      // Check if referrer is another customer
      const parentCust = await custCol.findOne({
        $or: [
          { customerId: refCode },
          { customer_id: refCode },
          { mobileNumber: refCode },
          { phone: refCode }
        ]
      });

      if (parentCust) {
        const rawToken = parentCust.token !== undefined && parentCust.token !== null ? parentCust.token : (parentCust.tokens || 0);
        uplines.push({
          level: level++,
          id: parentCust.customerId || parentCust.customer_id,
          member_code: parentCust.customerId || parentCust.customer_id,
          name: parentCust.fullName || parentCust.name || "Customer",
          mobile: parentCust.mobileNumber || parentCust.phone || "-",
          email: parentCust.email || "-",
          type: "Customer",
          token: Number(rawToken) || 0,
          rank_level: Number(parentCust.level || 0),
          status: parentCust.isActive !== false ? "Active" : "Inactive",
          date_joined: parentCust.createdAt
        });
        currentId = parentCust.customerId || parentCust.customer_id;
      } else {
        // It's a vendor referrer!
        reachedVendorCode = refCode;
        break;
      }
    }

    // If customer has a direct vendor_id and we haven't reached it yet
    if (!reachedVendorCode && targetCustomer?.vendor_id) {
      reachedVendorCode = targetCustomer.vendor_id;
    }

    // 2. If reached a vendor, look up in MemberModel and continue upline
    if (reachedVendorCode) {
      const vendorSponsor = await MemberModel.findOne({
        $or: [
          { Member_id: reachedVendorCode },
          { member_id: reachedVendorCode },
          { member_code: reachedVendorCode },
          { mobileno: reachedVendorCode }
        ]
      });

      if (vendorSponsor) {
        const rawToken = vendorSponsor.token !== undefined && vendorSponsor.token !== null ? vendorSponsor.token : (vendorSponsor.tokens || 0);
        uplines.push({
          level: level++,
          id: vendorSponsor.Member_id || vendorSponsor.member_id,
          member_code: vendorSponsor.member_code || vendorSponsor.Member_id || "-",
          name: vendorSponsor.Name || vendorSponsor.name || targetCustomer?.vendor_name || "Vendor",
          mobile: vendorSponsor.mobileno || vendorSponsor.contactno || reachedVendorCode,
          email: vendorSponsor.email || "-",
          type: "Vendor",
          token: Number(rawToken) || 0,
          rank_level: Number(vendorSponsor.level || 0),
          status: vendorSponsor.status || "Active",
          date_joined: vendorSponsor.Date_of_joining || vendorSponsor.createdAt
        });

        // Continue up the vendor chain!
        const vendorUplines = await findVendorUplines(vendorSponsor.Member_id || reachedVendorCode, 20 - level);
        for (const vu of vendorUplines) {
          uplines.push({
            ...vu,
            level: level++
          });
        }
      } else {
        uplines.push({
          level: level++,
          id: reachedVendorCode,
          member_code: reachedVendorCode,
          name: targetCustomer?.vendor_name || targetCustomer?.referralName || "Vendor",
          mobile: reachedVendorCode,
          email: "-",
          type: "Vendor",
          token: 0,
          rank_level: 0,
          status: "Active"
        });
      }
    }

    return res.status(200).json({
      success: true,
      target: targetCustomer ? {
        id: targetCustomer.customerId || targetCustomer.customer_id,
        name: targetCustomer.fullName || targetCustomer.name,
        mobile: targetCustomer.mobileNumber || targetCustomer.phone,
        email: targetCustomer.email,
        referralCode: targetCustomer.referralCode,
        referralName: targetCustomer.referralName,
        vendor_name: targetCustomer.vendor_name,
        token: Number(targetCustomer.token || 0),
        status: targetCustomer.isActive !== false ? "Active" : "Inactive"
      } : { id },
      count: uplines.length,
      uplines
    });
  } catch (error) {
    console.error("❌ Error fetching customer uplines:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch customer uplines",
      error: error.message
    });
  }
};

/**
 * GET /admin/token-contributors/vendor/:id
 * Returns all downline users (both vendors and customers across full downline hierarchy)
 * who awarded tokens to this Vendor, including each downline's own token balance.
 */
const getVendorTokenContributors = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: "Vendor ID is required" });
    }

    const targetVendor = await MemberModel.findOne({
      $or: [
        { Member_id: id },
        { member_id: id },
        { member_code: id },
        { mobileno: id },
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])
      ]
    });

    const vendorIds = targetVendor
      ? [targetVendor.Member_id, targetVendor.member_code, targetVendor.mobileno].filter(Boolean).map(String)
      : [String(id)];

    const client = mongoose.connection.client;
    let custCol = null;
    if (client) {
      try {
        custCol = client.db("ornate_auth").collection("customers");
      } catch (e) {}
    }
    if (!custCol && mongoose.connection.db) {
      custCol = mongoose.connection.db.collection("customers");
    }

    const contributors = [];
    const visitedVendors = new Set(vendorIds);
    const visitedCusts = new Set();

    let currentVendorIds = [...vendorIds];
    let currentCustCodes = [];
    let lvl = 1;

    // Unified BFS downline traversal up to 20 levels
    while ((currentVendorIds.length > 0 || currentCustCodes.length > 0) && lvl <= 20) {
      const nextVendorIds = [];
      const nextCustCodes = [];

      // 1. Find downline vendors sponsored by previous level vendors
      if (currentVendorIds.length > 0) {
        const downlineVendors = await MemberModel.find({
          $or: [
            { sponsor_id: { $in: currentVendorIds } },
            { Sponsor_code: { $in: currentVendorIds } },
            { introducer: { $in: currentVendorIds } }
          ]
        }).lean();

        for (const dv of downlineVendors) {
          const dvId = String(dv.Member_id || dv.member_id || dv.member_code || dv._id);
          if (visitedVendors.has(dvId)) continue;
          visitedVendors.add(dvId);

          const rawToken = dv.token !== undefined && dv.token !== null ? dv.token : (dv.tokens || 0);

          contributors.push({
            level: lvl,
            id: dv.Member_id || dv.member_code,
            member_code: dv.member_code || dv.Member_id,
            name: dv.Name || dv.name || "Vendor",
            mobile: dv.mobileno || dv.contactno || "-",
            email: dv.email || "-",
            type: "Vendor",
            tokensAwarded: 1,
            userToken: Number(rawToken) || 0,
            status: dv.status || "Active",
            date: dv.Date_of_joining || dv.createdAt
          });

          if (dv.Member_id) nextVendorIds.push(String(dv.Member_id));
          if (dv.member_code) nextVendorIds.push(String(dv.member_code));
          if (dv.mobileno) nextVendorIds.push(String(dv.mobileno));
        }
      }

      // 2. Find downline customers sponsored by previous level vendors OR previous level customers
      if (custCol) {
        const custQueries = [];
        if (currentVendorIds.length > 0) {
          custQueries.push({ referralCode: { $in: currentVendorIds } });
          custQueries.push({ vendor_id: { $in: currentVendorIds } });
        }
        if (currentCustCodes.length > 0) {
          custQueries.push({ referralCode: { $in: currentCustCodes } });
        }

        if (custQueries.length > 0) {
          const downlineCusts = await custCol.find({ $or: custQueries }).toArray();

          for (const dc of downlineCusts) {
            const dcId = String(dc.customerId || dc.customer_id || dc._id);
            if (visitedCusts.has(dcId)) continue;
            visitedCusts.add(dcId);

            const rawToken = dc.token !== undefined && dc.token !== null ? dc.token : (dc.tokens || dc.customer_tokens || 0);

            contributors.push({
              level: lvl,
              id: dc.customerId || dc.customer_id || dcId,
              member_code: dc.customerId || dc.customer_id || dcId,
              name: dc.fullName || dc.name || "Customer",
              mobile: dc.mobileNumber || dc.phone || "-",
              email: dc.email || "-",
              type: "Customer",
              tokensAwarded: 1,
              userToken: Number(rawToken) || 0,
              status: dc.isActive !== false ? "Active" : "Inactive",
              date: dc.createdAt
            });

            if (dc.customerId) nextCustCodes.push(String(dc.customerId));
            if (dc.customer_id) nextCustCodes.push(String(dc.customer_id));
            if (dc.mobileNumber) nextCustCodes.push(String(dc.mobileNumber));
            if (dc.phone) nextCustCodes.push(String(dc.phone));
          }
        }
      }

      currentVendorIds = nextVendorIds;
      currentCustCodes = nextCustCodes;
      lvl++;
    }

    // Sort contributors by level ascending, then date descending
    contributors.sort((a, b) => a.level - b.level || new Date(b.date) - new Date(a.date));

    const totalDownlineTokens = contributors.reduce((sum, c) => sum + (Number(c.userToken) || 0), 0);

    return res.status(200).json({
      success: true,
      target: targetVendor ? {
        id: targetVendor.Member_id || targetVendor.member_id,
        member_code: targetVendor.member_code || targetVendor.Member_id,
        name: targetVendor.Name || targetVendor.name,
        mobile: targetVendor.mobileno || targetVendor.contactno,
        token: Number(targetVendor.token || targetVendor.tokens || 0),
        status: targetVendor.status || "Active"
      } : { id },
      totalTokensAwarded: contributors.length,
      totalDownlineTokens,
      count: contributors.length,
      contributors
    });
  } catch (error) {
    console.error("❌ Error fetching vendor token contributors:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch vendor token contributors",
      error: error.message
    });
  }
};

/**
 * GET /admin/token-contributors/customer/:id
 * Returns all downline customers who awarded tokens to this Customer
 */
const getCustomerTokenContributors = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: "Customer ID is required" });
    }

    const client = mongoose.connection.client;
    let custCol = null;
    if (client) {
      try {
        custCol = client.db("ornate_auth").collection("customers");
      } catch (e) {}
    }
    if (!custCol && mongoose.connection.db) {
      custCol = mongoose.connection.db.collection("customers");
    }

    if (!custCol) {
      return res.status(500).json({ success: false, message: "Customer collection not available" });
    }

    const targetCustomer = await custCol.findOne({
      $or: [
        { customerId: id },
        { customer_id: id },
        { mobileNumber: id },
        { phone: id },
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: new mongoose.Types.ObjectId(id) }] : [])
      ]
    });

    const targetCodes = targetCustomer
      ? [targetCustomer.customerId, targetCustomer.customer_id, targetCustomer.mobileNumber, targetCustomer.phone].filter(Boolean).map(String)
      : [String(id)];

    const contributors = [];
    const visitedCusts = new Set(targetCodes);

    let currentLevelCodes = [...targetCodes];
    let lvl = 1;

    while (currentLevelCodes.length > 0 && lvl <= 20) {
      const downlines = await custCol.find({
        referralCode: { $in: currentLevelCodes }
      }).toArray();

      if (!downlines.length) break;

      const nextLevelCodes = [];
      for (const dc of downlines) {
        const dcId = String(dc.customerId || dc.customer_id || dc._id);
        if (visitedCusts.has(dcId)) continue;
        visitedCusts.add(dcId);

        const rawToken = dc.token !== undefined && dc.token !== null ? dc.token : (dc.tokens || dc.customer_tokens || 0);

        contributors.push({
          level: lvl,
          id: dc.customerId || dc.customer_id,
          member_code: dc.customerId || dc.customer_id,
          name: dc.fullName || dc.name || "Customer",
          mobile: dc.mobileNumber || dc.phone || "-",
          email: dc.email || "-",
          type: "Customer",
          tokensAwarded: 1,
          userToken: Number(rawToken) || 0,
          status: dc.isActive !== false ? "Active" : "Inactive",
          date: dc.createdAt
        });

        if (dc.customerId) nextLevelCodes.push(String(dc.customerId));
        if (dc.customer_id) nextLevelCodes.push(String(dc.customer_id));
        if (dc.mobileNumber) nextLevelCodes.push(String(dc.mobileNumber));
        if (dc.phone) nextLevelCodes.push(String(dc.phone));
      }

      currentLevelCodes = nextLevelCodes;
      lvl++;
    }

    contributors.sort((a, b) => a.level - b.level || new Date(b.date) - new Date(a.date));

    const totalDownlineTokens = contributors.reduce((sum, c) => sum + (Number(c.userToken) || 0), 0);

    return res.status(200).json({
      success: true,
      target: targetCustomer ? {
        id: targetCustomer.customerId || targetCustomer.customer_id,
        name: targetCustomer.fullName || targetCustomer.name,
        mobile: targetCustomer.mobileNumber || targetCustomer.phone,
        email: targetCustomer.email,
        token: Number(targetCustomer.token || 0),
        status: targetCustomer.isActive !== false ? "Active" : "Inactive"
      } : { id },
      totalTokensAwarded: contributors.length,
      totalDownlineTokens,
      count: contributors.length,
      contributors
    });
  } catch (error) {
    console.error("❌ Error fetching customer token contributors:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch customer token contributors",
      error: error.message
    });
  }
};

module.exports = {
  getVendorUplines,
  getCustomerUplines,
  getVendorTokenContributors,
  getCustomerTokenContributors
};

