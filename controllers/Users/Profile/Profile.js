const MemberModel = require("../../../models/Users/Member");
const mongoose = require("mongoose");
const moment = require("moment");
const AdminModel = require("../../../models/Admin/Admin");
const TransactionModel = require("../../../models/Transaction/Transaction");
const PayoutModel = require("../../../models/Payout/Payout");
const { triggerMLMCommissions } = require("../Payout/PayoutController");
const { processMemberROI } = require("../roiService/roiService");
const AddOnPackageModel = require("../../../models/Packages/AddOnPackage");

const getMemberDetails = async (req, res) => {
  try {
    const id = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid User ID"
      });
    }

    const foundUser = await MemberModel.findById(id) || await AdminModel.findById(id);

    if (!foundUser) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // If admin, return all members with their total package value
    if (foundUser instanceof AdminModel) {
      const members = await MemberModel.aggregate([
        {
          $lookup: {
            from: "add_on_package_tbl",
            localField: "Member_id",
            foreignField: "member_id",
            as: "addons"
          }
        },
        {
          $addFields: {
            // Calculate total sum of all packages (Primary + Add-ons)
            total_package_value: {
              $add: [
                { $ifNull: ["$package_value", 0] },
                { $sum: "$addons.amount" }
              ]
            },
            level: { $ifNull: ["$level", 0] }
          }
        },
        {
          $sort: { createdAt: -1 } // Optional: Keep recent members at top
        }
      ]);

      return res.status(200).json({
        success: true,
        data: foundUser,
        members
      });
    }

    // For regular members - get actual registration counts from database
    const directCount = await MemberModel.countDocuments({
      $or: [
        { introducer: foundUser.Member_id },
        { sponsor_id: foundUser.Member_id },
        { Sponsor_code: foundUser.Member_id }
      ]
    });

    const totalTeamCount = await MemberModel.countDocuments({
      $or: [
        { introducer_hierarchy: foundUser.Member_id },
        { referral_path: { $regex: foundUser.Member_id, $options: 'i' } }
      ]
    });

    const indirectCount = totalTeamCount - directCount;

    if (!foundUser.qr_code && (foundUser.Member_id || foundUser.member_id)) {
      foundUser.qr_code = `BMS-P2P:${foundUser.Member_id || foundUser.member_id}`;
      await foundUser.save();
    }

    if (!foundUser.member_code && foundUser instanceof MemberModel) {
      const allMembersWithCode = await MemberModel.find({ member_code: { $exists: true, $ne: null } })
        .select("member_code")
        .lean();

      let maxCode = 100;
      for (const m of allMembersWithCode) {
        const num = parseInt(m.member_code, 10);
        if (!isNaN(num) && num > maxCode) {
          maxCode = num;
        }
      }
      const nextCode = maxCode + 1;
      foundUser.member_code = String(nextCode).padStart(4, "0");
      await foundUser.save();
    }

    const idStr = String(foundUser.Member_id || foundUser.member_id || '1');
    let numericPart = idStr.replace(/\D/g, '');
    if (!numericPart) {
      let seed = 5381;
      for (let i = 0; i < idStr.length; i++) {
        seed = (seed * 33) ^ idStr.charCodeAt(i);
      }
      numericPart = String(Math.abs(seed));
    }
    const last6 = numericPart.padStart(6, '0').slice(-6);
    const virtual_card_number = ('4638292644' + last6).replace(/(.{4})/g, '$1 ').trim();
    const memberCodeFormatted = foundUser.member_code || '0101';

    // Compute investment status
    const memberIdVal = foundUser.Member_id || foundUser.member_id;
    const addonPackages = await AddOnPackageModel.find({ member_id: memberIdVal, request_id: { $ne: 'PRIMARY' } });
    const totalAddonAmount = addonPackages.reduce((acc, pkg) => acc + (pkg.amount || 0), 0);
    const totalPackages = (Number(foundUser.package_value) || 0) + totalAddonAmount;
    const hasInvestment = totalPackages > 0;

    let totalEarnings = 0;
    if (hasInvestment) {
      const completedTxs = await TransactionModel.find({
        member_id: memberIdVal,
        status: "Completed"
      });
      const levelBenefits = completedTxs.filter(tx => {
        const txType = tx.transaction_type?.toLowerCase() || "";
        const desc = tx.description?.toLowerCase() || "";
        return (txType.includes("level benefit") || txType.includes("level bonus") || tx.benefit_type?.toLowerCase().includes("level income")) &&
          !txType.includes("roi") && !desc.includes("roi") && !txType.includes("referral") && !desc.includes("referral");
      }).reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.uw_credit) || 0) + (parseFloat(tx.fd_credit) || 0) + (parseFloat(tx.pw_credit) || 0), 0);
      const roiLevelBenefits = completedTxs.filter(tx => tx.transaction_type === "ROI Level Benefit").reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.uw_credit) || 0) + (parseFloat(tx.fd_credit) || 0) + (parseFloat(tx.pw_credit) || 0), 0);
      const directBenefits = completedTxs.filter(tx => {
        const txType = tx.transaction_type?.toLowerCase() || "";
        const desc = tx.description?.toLowerCase() || "";
        return txType === "direct benefits" || desc === "direct benefits" || txType.includes("referral") || desc.includes("referral");
      }).reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.uw_credit) || 0) + (parseFloat(tx.fd_credit) || 0) + (parseFloat(tx.pw_credit) || 0), 0);
      const repaymentCommission = completedTxs.filter(tx => (tx.transaction_type?.toLowerCase().includes("repayment commission") || tx.description?.toLowerCase().includes("repayment commission"))).reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0), 0);
      const roiBenefits = completedTxs.filter(tx => tx.transaction_type === "ROI Payout").reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.uw_credit) || 0) + (parseFloat(tx.fd_credit) || 0) + (parseFloat(tx.pw_credit) || 0), 0);
      const singleLineIncome = completedTxs.filter(tx => (
        tx.transaction_type === "Daily Incentive" ||
        tx.transaction_type === "Single Line Income" ||
        tx.transaction_type === "Single Level Income" ||
        tx.transaction_type === "Single Leg Income" ||
        tx.transaction_type === "ROI Payout" ||
        tx.description?.toLowerCase().includes("daily incentive")
      )).reduce((acc, tx) => acc + (parseFloat(tx.gross_amount) || parseFloat(tx.net_amount) || ((parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.tw_credit) || 0)) || parseFloat(tx.ew_credit) || 0), 0);

      totalEarnings = levelBenefits + roiLevelBenefits + directBenefits + repaymentCommission + roiBenefits + singleLineIncome;
    }
    const canReinvest = hasInvestment && totalPackages > 0 && totalEarnings >= (2 * totalPackages);

    // Add registration data to response
    const responseData = {
      ...foundUser.toObject(),
      member_code: memberCodeFormatted,
      user_id: memberCodeFormatted,
      reference_id: memberCodeFormatted,
      virtual_card_number,
      qr_code: foundUser.qr_code || `BMS-P2P:${foundUser.Member_id || foundUser.member_id}`,
      registration_stats: {
        direct: directCount,
        indirect: indirectCount,
        total: totalTeamCount
      },
      totalPackages: totalPackages,
      totalEarnings: totalEarnings,
      hasInvestment: hasInvestment,
      canReTopup: canReinvest,
      canReinvest: canReinvest
    };

    return res.status(200).json({
      success: true,
      hasInvestment: hasInvestment,
      canReTopup: canReinvest,
      canReinvest: canReinvest,
      data: responseData
    });

  } catch (error) {
    console.error("Error fetching User details:", error);
    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};

const activateMemberPackage = async (req, res) => {
  try {
    if (req.user.role !== "ADMIN") {
      return res.status(403).json({ success: false, message: "Access Denied" });
    }

    const { memberId } = req.params;
    const { packageType } = req.body;
    if (!memberId || !packageType) {
      return res.status(400).json({ success: false, message: "Member ID and package type are required" });
    }

    const existingMember = await MemberModel.findOne({
      $or: [{ Member_id: memberId }, { member_id: memberId }]
    });
    if (!existingMember) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }

    const actualMemberId = existingMember.Member_id || existingMember.member_id || memberId;

    // Dynamically accept any Ecash / BMS / PKG / direct numeric amount or "NONE"
    let selectedPackage = null;
    if (packageType === "NONE") {
      selectedPackage = { name: "NONE", value: 0 };
    } else if (packageType && (packageType.startsWith("Eshopy_") || packageType.startsWith("Ecash_") || packageType.startsWith("BMS_") || packageType.startsWith("PKG-") || packageType.startsWith("PKG_"))) {
      const amtStr = packageType.replace(/^(Eshopy_|Ecash_|BMS_|PKG-|PKG_)/, "");
      const amt = Number(amtStr);
      if (!isNaN(amt) && amt > 0) {
        selectedPackage = { name: `PKG-${amt}`, value: amt };
      }
    } else if (!isNaN(Number(packageType)) && Number(packageType) > 0) {
      const amt = Number(packageType);
      selectedPackage = { name: `PKG-${amt}`, value: amt };
    }

    if (!selectedPackage) {
      return res.status(400).json({ success: false, message: "Invalid package selection" });
    }

    const activationDate = moment().utcOffset("+05:30").format("YYYY-MM-DD");

    // ── CASE A: Activation WITHOUT Package ──
    if (selectedPackage.name === "NONE") {
      console.log(`👤 [Activation] Activating ${actualMemberId} WITHOUT package.`);

      const updatedMember = await MemberModel.findOneAndUpdate(
        { $or: [{ Member_id: actualMemberId }, { member_id: actualMemberId }] },
        {
          status: "active",
          Date_of_joining: activationDate
        },
        { new: true }
      );

      return res.status(200).json({
        success: true,
        data: updatedMember,
        commissions: [],
        totalCommission: 0,
        message: "Member activated successfully without a package."
      });
    }

    // ── CASE B: Activation WITH Package ──
    const amount = selectedPackage.value;
    console.log(`💎 [Activation] Activating ${actualMemberId} WITH ₹${amount} package.`);

    // 1. Update member_tbl basic status & ROI settings
    const updatedMember = await MemberModel.findOneAndUpdate(
      { $or: [{ Member_id: actualMemberId }, { member_id: actualMemberId }] },
      {
        status: "active",
        spackage: selectedPackage.name,
        package_value: amount,
        upgrade_status: "Active", // Activated with package
        Date_of_joining: activationDate,
        roi_status: "Active",
        roi_payout_target: 200,
        roi_payout_count: 0,
        roi_daily_amount: Math.round(amount * 0.01 * 100) / 100,
        roi_total_paid: 0,
        roi_start_date: activationDate,
        roi_last_payout_date: null,
      },
      { new: true }
    );

    if (!updatedMember) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }

    // 2. ✅ CREATE "DAY 0" PAYOUT AND TRANSACTION (₹0 records)
    const payoutId = Date.now() + Math.floor(Math.random() * 1000);
    const payout = new PayoutModel({
      payout_id: payoutId,
      date: moment().utcOffset("+05:30").toDate(),
      memberId: actualMemberId,
      payout_type: "ROI (Primary)",
      ref_no: `ACT-P-${actualMemberId}-0`,
      amount: 0,
      count: 0,
      days: 300,
      status: "Approved",
      description: "Primary Package Activation"
    });

    const activationTx = new TransactionModel({
      transaction_id: `ACT-P-TX-${payoutId}`,
      transaction_date: activationDate,
      member_id: actualMemberId,
      Name: updatedMember.Name || updatedMember.name,
      mobileno: updatedMember.mobileno || updatedMember.contactno,
      description: `Package Activation – Day 0/300 (₹${amount} pkg)`,
      transaction_type: "ROI Payout",
      ew_credit: "0",
      ew_debit: "0",
      status: "Completed",
      benefit_type: "ROI",
      reference_no: payout.ref_no
    });

    await Promise.all([payout.save(), activationTx.save()]);

    // 4. ✅ Trigger MLM level commissions
    try {
      const sponsorCode = updatedMember.Sponsor_code || updatedMember.sponsor_id || existingMember.Sponsor_code || existingMember.sponsor_id;
      req.body.new_member_id = actualMemberId;
      req.body.Sponsor_code = sponsorCode;

      let mlmData = null;
      if (sponsorCode) {
        await triggerMLMCommissions(req, {
          status: (code) => ({
            json: (data) => { mlmData = data; return data; }
          }),
          json: (data) => { mlmData = data; return data; }
        });

        // 4.1 Update Sponsor Level & Continuous ROI
        try {
          const { checkAndUpdateSponsorLevel } = require("../roiService/sponsorLevelService");
          await checkAndUpdateSponsorLevel(sponsorCode);
        } catch (lvlErr) {
          console.error("⚠️ Sponsor level promotion check failed:", lvlErr.message);
        }
      }

      const commissions = mlmData?.commissions || mlmData?.data?.commissions || [];
      const totalCommission = mlmData?.totalCommission || mlmData?.data?.totalCommission || 0;

      return res.status(200).json({
        success: true,
        data: {
          ...(updatedMember.toObject ? updatedMember.toObject() : updatedMember),
          commissions,
          totalCommission
        },
        commissions,
        totalCommission,
        message: `${selectedPackage.name} activated and stored in add-on table.`,
        mlm_result: mlmData
      });
    } catch (mlmError) {
      console.error("❌ MLM Error during activation:", mlmError);
      return res.status(200).json({
        success: true,
        data: updatedMember,
        message: "Member activated with package, but referral update failed.",
        mlm_error: mlmError.message,
        commissions: [],
        totalCommission: 0
      });
    }

  } catch (error) {
    console.error("Error activating package:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message
    });
  }
};

const getMember = async (req, res) => {
  try {
    if (req.user.role !== "ADMIN") {
      return res
        .status(403)
        .json({ success: false, message: "Access Denied", });
    }
    const memberId = req.params.memberId;
    const member = await MemberModel.findOne({
      $or: [
        { Member_id: memberId },
        { member_id: memberId },
        { mobileno: memberId },
        { contactno: memberId },
        { member_code: memberId }
      ]
    });
    if (!member) {
      return res
        .status(404)
        .json({ success: false, message: "Member not found", });
    }
    return res.status(200).json({ success: true, member });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const UpdateMemberDetails = async (req, res) => {
  try {
    let memberId;

    if (req.user.role === "ADMIN") {
      memberId = req.params.memberId;
    } else {
      memberId = req.user.memberId;
    }

    if (!memberId) {
      return res.status(400).json({
        success: false,
        message: "Member ID is required",
      });
    }

    const { oldPassword, newPassword, ...updateData } = req.body;

    // Find the user by Member_id (not _id)
    const foundUser = await MemberModel.findOne({ Member_id: memberId });

    if (!foundUser) {
      return res.status(404).json({
        success: false,
        message: "Member not found",
      });
    }

    // Handle password update
    if (oldPassword && newPassword) {
      if (oldPassword !== foundUser.password) {
        return res.status(401).json({
          success: false,
          message: "Old password is incorrect",
        });
      }
      if (oldPassword === newPassword) {
        return res.status(400).json({
          success: false,
          message: "New password cannot be the same as old password",
        });
      }
      if (newPassword.length <= 5) {
        return res.status(400).json({
          success: false,
          message: "Password must be at least 6 characters long",
        });
      }

      updateData.password = newPassword;
    }

    // Update user details
    const updatedMember = await MemberModel.findOneAndUpdate(
      { Member_id: memberId },
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (!updatedMember) {
      return res.status(404).json({
        success: false,
        message: "Member not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Member details updated successfully",
      data: updatedMember,
    });
  } catch (error) {
    console.error("Error updating member details:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};
const updateMemberStatus = async (req, res) => {
  try {
    const { memberId } = req.params;
    const { status, upgrade_status } = req.body;

    if (!status && !upgrade_status) {
      return res.status(400).json({ success: false, message: "Status or Upgrade Status is required" });
    }

    let query;
    if (mongoose.Types.ObjectId.isValid(memberId)) {
      query = { _id: memberId };
    } else {
      query = { $or: [{ Member_id: memberId }, { member_id: memberId }] };
    }

    const existingMember = await MemberModel.findOne(query);
    if (!existingMember) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }

    const activationDate = moment().utcOffset("+05:30").format("YYYY-MM-DD");
    const updatePayload = {};

    // Handle main status update
    if (status) {
      if (status === 'active' && existingMember.status === 'active') {
        return res.status(400).json({ success: false, message: "Member is already active." });
      }
      updatePayload.status = status;
    }

    // Handle upgrade_status (UI visibility) update
    if (upgrade_status) {
      updatePayload.upgrade_status = upgrade_status;
    }

    // Special logic for first-time activation from Pending
    if (existingMember.upgrade_status === "Pending" && status === "active") {
      updatePayload.roi_status = 'Active';
      updatePayload.upgrade_status = 'Active';
      updatePayload.roi_payout_count = 0;
      updatePayload.roi_start_date = activationDate;
      updatePayload.roi_last_payout_date = activationDate;
      if (existingMember.package_value && existingMember.package_value > 0) {
        updatePayload.roi_payout_target = (existingMember.package_value || 0) * 3;
      }
    }

    const updatedMember = await MemberModel.findOneAndUpdate(query, { $set: updatePayload }, { new: true });

    // ✅ Create "Day 0" Payout and Transaction if newly activated (from Pending)
    if (existingMember.upgrade_status === "Pending" && status === "active") {
      const payoutId = Date.now() + Math.floor(Math.random() * 1000);
      const payout = new PayoutModel({
        payout_id: payoutId,
        date: moment().utcOffset("+05:30").toDate(),
        memberId: updatedMember.Member_id,
        payout_type: "ROI",
        ref_no: `ACT-${updatedMember.Member_id}-0`,
        amount: 0,
        count: 0,
        days: 300,
        status: "Approved",
        description: "Package Activation"
      });

      const activationTx = new TransactionModel({
        transaction_id: `ACT-TX-${payoutId}`,
        transaction_date: activationDate,
        member_id: updatedMember.Member_id,
        Name: updatedMember.Name,
        mobileno: updatedMember.mobileno,
        description: `Package Activation – Daily ROI (Day 0/300)`,
        transaction_type: "ROI Payout",
        ew_credit: "0",
        ew_debit: "0",
        status: "Completed",
        benefit_type: "ROI",
        reference_no: payout.ref_no
      });
      await Promise.all([payout.save(), activationTx.save()]);

      try {
        // Trigger MLM commissions
        await triggerMLMCommissions({
          body: {
            new_member_id: updatedMember.Member_id,
            Sponsor_code: updatedMember.sponsor_id || updatedMember.Sponsor_code
          }
        }, {
          status: (code) => ({ json: (data) => data }),
          json: (data) => data
        });
      } catch (mlmError) {
        console.error("MLM Commission Error:", mlmError);
      }
    }

    return res.status(200).json({
      success: true,
      message: "Member status updated",
      data: updatedMember
    });
  } catch (error) {
    console.error("Error updating member status:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

module.exports = { getMemberDetails, UpdateMemberDetails, getMember, activateMemberPackage, updateMemberStatus };
