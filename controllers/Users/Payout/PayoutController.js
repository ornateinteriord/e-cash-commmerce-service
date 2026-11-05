const PayoutModel = require("../../../models/Payout/Payout");
const TransactionModel = require("../../../models/Transaction/Transaction");
const MemberModel = require("../../../models/Users/Member");
const {
  updateSponsorReferrals,
  calculateCommissions,
  processCommissions,
  getOrdinal,
  commissionRates,
  getUplineTree,
  createLevelRoiSchedules
} = require("../mlmService/mlmService");
const { processDailyROI } = require("../roiService/roiService");

// Reusable function to update referral hierarchy when a member becomes active
const updateReferralHierarchy = async (newMemberId, sponsorId) => {
  try {
    const newMember = await MemberModel.findOne({ Member_id: newMemberId });
    if (!newMember) throw new Error(`Member not found: ${newMemberId}`);
    if (newMember.status !== "active") throw new Error(`Member status must be active, current status: ${newMember.status}`);

    const sponsor = await MemberModel.findOne({ Member_id: sponsorId });
    if (!sponsor) throw new Error(`Sponsor not found with ID: ${sponsorId}`);

    if (newMember.sponsor_id !== sponsor.Member_id) {
      await MemberModel.findOneAndUpdate(
        { Member_id: newMemberId },
        { sponsor_id: sponsor.Member_id, Sponsor_code: sponsor.Member_id, Sponsor_name: sponsor.Name }
      );
    }

    await updateSponsorReferrals(sponsor.Member_id, newMemberId);

    return { success: true, new_member: { id: newMemberId }, sponsor: { id: sponsor.Member_id } };
  } catch (error) {
    console.error("❌ Error updating referral hierarchy:", error.message || error);
    throw error;
  }
};

const triggerMLMCommissions = async (req, res) => {
  try {
    const new_member_id = req.body?.new_member_id || req.query?.new_member_id;
    const Sponsor_code = req.body?.Sponsor_code || req.query?.Sponsor_code;

    console.log("🟢 Incoming Request Data (Referral Update Only):", { new_member_id, Sponsor_code });

    if (!new_member_id || !Sponsor_code) {
      return res.status(400).json({
        success: false,
        message: "Member ID and Sponsor code are required"
      });
    }

    // Find new member
    const newMember = await MemberModel.findOne({
      $or: [{ Member_id: new_member_id }, { member_id: new_member_id }]
    });

    if (!newMember) {
      return res.status(404).json({
        success: false,
        message: `Member not found: ${new_member_id}`
      });
    }

    if (String(newMember.status || "").toLowerCase() !== "active") {
      return res.status(400).json({
        success: false,
        message: `Member status must be active, current status: ${newMember.status}`
      });
    }

    // Find sponsor using flexible lookup
    const sponsor = await MemberModel.findOne({
      $or: [
        { Member_id: Sponsor_code },
        { member_id: Sponsor_code },
        { member_code: Sponsor_code },
        { mobileno: Sponsor_code }
      ]
    });
    console.log("📗 Found Sponsor:", sponsor);

    if (!sponsor) {
      return res.status(404).json({
        success: false,
        message: `Sponsor not found with ID: ${Sponsor_code}`
      });
    }

    const actualMemberId = newMember.Member_id || newMember.member_id;
    const actualSponsorId = sponsor.Member_id || sponsor.member_id;

    // Update member's sponsor details if needed
    if (newMember.sponsor_id !== actualSponsorId) {
      await MemberModel.findOneAndUpdate(
        { $or: [{ Member_id: actualMemberId }, { member_id: actualMemberId }] },
        {
          sponsor_id: actualSponsorId,
          Sponsor_code: actualSponsorId,
          Sponsor_name: sponsor.Name || sponsor.name
        }
      );
      console.log("🔄 Updated sponsor details for new member:", actualMemberId);
    }

    // Update direct sponsor's referrals list
    await updateSponsorReferrals(actualSponsorId, actualMemberId);
    console.log("👥 Direct sponsor referrals updated");

    // Check and update sponsor level based on referrals
    try {
      const { checkAndUpdateSponsorLevel } = require("../roiService/sponsorLevelService");
      await checkAndUpdateSponsorLevel(actualSponsorId);
    } catch (lvlErr) {
      console.error("⚠️ Sponsor level update failed:", lvlErr.message);
    }

    // Calculate and process multi-level commissions (up to 10 levels based on percentage)
    const packageAmount = Number(newMember.package_value || newMember.spackage || 0);
    const commissions = await calculateCommissions(actualMemberId, actualSponsorId, packageAmount > 0 ? packageAmount : null);
    let commissionResults = [];
    if (commissions.length > 0) {
      commissionResults = await processCommissions(commissions);
      console.log(`💰 Processed ${commissionResults.length} commissions for new member ${actualMemberId}`);
    } else {
      console.log(`⚠️ No commissions generated for new member ${actualMemberId}`);
    }

    // Create 50-day Level ROI schedules for eligible uplines (Levels 1 to 7 with sponsor_level >= 3)
    let levelRoiSchedules = [];
    if (packageAmount > 0) {
      levelRoiSchedules = await createLevelRoiSchedules(actualMemberId, packageAmount);
      console.log(`📅 Created ${levelRoiSchedules.length} 50-day Level ROI schedules for new member ${actualMemberId}`);
    }

    const formattedCommissions = commissions.map(c => ({
      level: c.level,
      memberId: c.sponsor_id,
      memberName: c.sponsor_name,
      commissionType: c.payout_type || `Level ${c.level} Commission`,
      amount: Number(c.amount || 0)
    }));
    const totalCommission = formattedCommissions.reduce((sum, c) => sum + (c.amount || 0), 0);

    return res.status(200).json({
      success: true,
      message: "Referral hierarchy and commissions updated successfully",
      data: {
        new_member: { id: actualMemberId },
        sponsor: { id: actualSponsorId },
        commissions_generated: commissions.length,
        commissions_processed: commissionResults.filter(r => r.success).length,
        commissions: formattedCommissions,
        totalCommission,
        level_roi_schedules_created: levelRoiSchedules.length
      },
      commissions: formattedCommissions,
      totalCommission,
      level_roi_schedules_created: levelRoiSchedules.length
    });

  } catch (error) {
    console.error("❌ Error triggering MLM commissions:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};


const getMemberCommissionSummary = async (req, res) => {
  try {
    const member_id = req.params.member_id || req.user?.memberId;

    if (!member_id) {
      return res.status(400).json({ success: false, message: "Member ID is required" });
    }

    // Get member from MemberModel
    const member = await MemberModel.findOne({
      $or: [{ Member_id: member_id }, { member_id: member_id }]
    });

    // Get all payouts and transactions for the member
    const payouts = await PayoutModel.find({
      $or: [{ memberId: member_id }, { sponsor_id: member_id }]
    }).sort({ createdAt: -1 });

    const transactions = await TransactionModel.find({
      $or: [{ member_id: member_id }]
    }).sort({ createdAt: -1 });

    // Calculate level earnings from payouts
    const levelEarnings = {};
    let totalEarnings = 0;

    for (let level = 1; level <= 7; level++) {
      const levelPayouts = payouts.filter((p) => p.level === level);
      const levelAmount = levelPayouts.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
      totalEarnings += levelAmount;

      const rate = level === 1 ? 10 : (level === 2 ? 3 : (level === 3 ? 2 : 1));
      levelEarnings[`level_${level}`] = {
        count: levelPayouts.length,
        amount: Number(levelAmount.toFixed(2)),
        type: level === 1 ? "Direct Referral Bonus" : `Level ${level} Bonus`,
        rate: `${rate}%`,
      };
    }

    // Get upline tree
    const uplineTree = await getUplineTree(member_id, 7);

    return res.json({
      success: true,
      data: {
        member_id,
        member_name: member?.Name || member?.name || "Member",
        member_code: member?.member_code,
        mobile: member?.mobileno || member?.contactno,
        email: member?.email,
        sponsor_code: member?.Sponsor_code || member?.sponsor_id,
        sponsor_name: member?.Sponsor_name,
        direct_referrals: member?.direct_referrals?.length || 0,
        total_team: member?.total_team || 0,
        total_earnings: Number(totalEarnings.toFixed(2)),
        wallet_balance: member?.wallet_balance || 0,
        level_breakdown: levelEarnings,
        upline_tree: uplineTree,
        recent_payouts: payouts.slice(0, 10).map((p) => ({
          date: p.date,
          type: p.payout_type,
          amount: p.amount,
          level: p.level,
          from_member: p.sponsored_member_id || p.ref_no,
          status: p.status,
        })),
        recent_level_benefits: transactions
          .filter((tx) => tx.transaction_type === "Referral Bonus" || tx.transaction_type === "Level Bonus")
          .slice(0, 10)
          .map((tx) => ({
            date: tx.transaction_date,
            amount: parseFloat(tx.ew_credit) || parseFloat(tx.vw_credit) || 0,
            level: tx.level,
            from_member: tx.related_member_id,
            description: tx.description,
          })),
      },
    });
  } catch (error) {
    console.error("Error getting commission summary:", error);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

const getDailyPayout = async (req, res) => {
  try {
    const userRole = req.user.role;
    const { member_id } = req.params;

    let query = {};

    if (member_id) {
      const numericPart = parseInt(member_id.replace('BMS', ''), 10);
      const pad5 = String(numericPart).padStart(5, '0');
      const pad6 = String(numericPart).padStart(6, '0');
      const possibleIds = [member_id, member_id.replace('BMS', ''), `BMS${pad5}`, `BMS${pad6}`, pad5, pad6, `BMS${numericPart}`];

      if (userRole === "ADMIN") {
        query = { member_id: { $in: possibleIds } };
      } else if (userRole === "USER") {
        query = { member_id: { $in: possibleIds } };
      }
    }

    // Filter for Daily Incentive and Single Level / Line Income payouts
    const transactions = await TransactionModel.find({
      ...query,
      $or: [
        { transaction_type: { $in: ["Daily Incentive", "Single Level Income", "Single Leg Income", "Single Line Income", "ROI Payout", "Level Daily ROI"] } },
        { description: { $regex: /daily incentive|level daily roi/i } }
      ]
    }).sort({ transaction_date: -1, createdAt: -1 });

    return res.status(200).json({
      success: true,
      data: { daily_earnings: transactions },
    });


  } catch (error) {
    console.error("Error in getDailyPayout:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const LOAN_TIERS = [];

const climeRewardLoan = async (req, res) => {
  return res.status(403).json({ success: false, message: "Reward loans are disabled." });
};

const getRewardLoansByStatus = async (req, res) => {
  return res.status(200).json({ success: true, data: { loans: [], totalCount: 0 } });
};

const processRewardLoan = async (req, res) => {
  return res.status(403).json({ success: false, message: "Reward loans are disabled." });
};

const repaymentLoan = async (req, res) => {
  return res.status(403).json({ success: false, message: "Reward loans are disabled." });
};

const triggerDailyROI = async (req, res) => {
  try {
    const result = await processDailyROI();
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error processing ROI",
      error: error.message
    });
  }
};

const getROIBenefits = async (req, res) => {
  try {
    const userRole = req.user.role;
    const { member_id } = req.params;

    let query = {};

    if (userRole === "ADMIN") {
      query = member_id ? { member_id } : {};
    } else if (userRole === "USER") {
      query = { member_id: member_id };
    }

    // Filter strictly for ROI Level Benefits / Level Daily ROI with related member name population
    const transactions = await TransactionModel.aggregate([
      {
        $match: {
          ...query,
          transaction_type: { $in: ["ROI Level Benefit", "Level Daily ROI"] },
        }
      },
      {
        $lookup: {
          from: "vendor_tbl",
          localField: "related_member_id",
          foreignField: "Member_id",
          as: "related_member"
        }
      },
      {
        $addFields: {
          related_member_name: {
            $ifNull: [
              "$related_member_name",
              { $arrayElemAt: ["$related_member.Name", 0] }
            ]
          }
        }
      },
      {
        $project: {
          related_member: 0
        }
      },
      { $sort: { transaction_date: -1, createdAt: -1 } }
    ]);

    return res.status(200).json({
      success: true,
      data: { roi_benefits: transactions },
    });
  } catch (error) {
    console.error("Error in getROIBenefits:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const getROISummary = async (req, res) => {
  try {
    const todayStr = new Date().toISOString().split('T')[0];

    // 1. Total ROI Distributed
    const totalROIResult = await TransactionModel.aggregate([
      { $match: { transaction_type: "ROI Payout", status: "Completed" } },
      { $group: { _id: null, total: { $sum: { $toDouble: "$ew_credit" } } } }
    ]);
    const totalROIDistributed = totalROIResult[0]?.total || 0;

    // 2. Today's Payouts
    const todaysPayoutsResult = await TransactionModel.aggregate([
      {
        $match: {
          transaction_type: "ROI Payout",
          status: "Completed",
          transaction_date: todayStr
        }
      },
      { $group: { _id: null, total: { $sum: { $toDouble: "$ew_credit" } }, count: { $sum: 1 } } }
    ]);
    const todaysTotal = todaysPayoutsResult[0]?.total || 0;
    const todaysCount = todaysPayoutsResult[0]?.count || 0;

    // 3. Active ROI Contracts
    const activeContractsCount = await MemberModel.countDocuments({
      status: "active",
      roi_status: "Active"
    });

    return res.status(200).json({
      success: true,
      data: {
        totalROIDistributed,
        todaysTotal,
        todaysCount,
        activeContractsCount,
        lastUpdated: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error("Error in getROISummary:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};


const triggerUserROI = async (req, res) => {
  try {
    const { member_id } = req.params;
    if (!member_id) {
      return res.status(400).json({ success: false, message: "Member ID is required" });
    }

    console.log(`🎯 [ROI] Force Global Trigger by Member: ${member_id}`);
    const result = await processDailyROI();

    return res.status(200).json({
      success: true,
      message: "ROI check completed",
      data: result
    });
  } catch (error) {
    console.error("❌ Error in triggerUserROI:", error);
    return res.status(500).json({
      success: false,
      message: "Error processing ROI",
      error: error.message
    });
  }
};

const getLevelRoiSchedules = async (req, res) => {
  try {
    const LevelRoiScheduleModel = require("../../../models/Packages/LevelRoiSchedule");
    const userRole = req.user?.role;
    const member_id = req.params.member_id || (userRole === "USER" ? req.user.memberId : null);

    let query = {};
    if (member_id) {
      query.sponsor_id = member_id;
    }

    const schedules = await LevelRoiScheduleModel.find(query).sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      data: schedules
    });
  } catch (error) {
    console.error("Error in getLevelRoiSchedules:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message
    });
  }
};

async function cleanDuplicateReferralBonus(req = null, res = null) {
  try {
    const specificTxId = (req && req.params && req.params.txId) || (req && req.query && req.query.txId);
    let cleanedList = [];

    // If a specific transaction ID is provided, delete only that specific transaction
    if (specificTxId) {
      const dupTx = await TransactionModel.findOne({
        $or: [
          { transaction_id: specificTxId },
          { transaction_id: { $regex: specificTxId } }
        ]
      });

      if (dupTx) {
        const amount = Number(dupTx.vw_credit || dupTx.ew_credit || dupTx.net_amount || 0);
        const memberId = dupTx.member_id;

        await MemberModel.updateOne(
          { $or: [{ Member_id: memberId }, { member_id: memberId }] },
          { $inc: { earning_wallet: -amount } }
        );

        if (dupTx.reference_no) {
          await PayoutModel.deleteMany({ payout_id: dupTx.reference_no });
          const CommissionModel = require("../../../models/commission.model");
          await CommissionModel.deleteMany({ transaction_id: dupTx.transaction_id });
        }

        await TransactionModel.deleteOne({ _id: dupTx._id });
        cleanedList.push(dupTx.transaction_id);
      }
    } else {
      // Safe no-op on automatic overview calls to prevent accidental deletion of valid commissions
      console.log("ℹ️ [CLEANUP] Routine scan skipped to preserve valid commission history.");
    }

    const resultData = {
      success: true,
      message: `Cleaned ${cleanedList.length} duplicate referral transactions`,
      cleanedTransactions: cleanedList
    };

    if (res && typeof res.status === "function") {
      return res.status(200).json(resultData);
    }
    return resultData;
  } catch (error) {
    console.error("❌ Error cleaning duplicate referral bonus:", error);
    if (res && typeof res.status === "function") {
      return res.status(500).json({ success: false, error: error.message });
    }
    return { success: false, error: error.message };
  }
}

async function syncAllMissingCommissions(req = null, res = null) {
  try {
    const isForce = (req?.query?.force === "true" || req?.query?.recalculate === "true" || req?.body?.force === true || req?.body?.recalculate === true);
    console.log(`🔄 [SYNC] Starting sync of commissions (force/recalculate: ${isForce})...`);

    if (isForce) {
      console.log("🧹 [SYNC] Recalculate enabled: removing old referral & level commission transactions and payouts...");
      await TransactionModel.deleteMany({
        $or: [
          { transaction_type: { $in: ["Referral Bonus", "Product Level Income", "Level Income"] } },
          { description: { $regex: /referral|level \d+ income|product level/i } }
        ]
      });
      await PayoutModel.deleteMany({
        $or: [
          { payout_type: { $regex: /referral|level \d+ income|product level/i } }
        ]
      });
      const CommissionModel = require("../../../models/commission.model");
      await CommissionModel.deleteMany({
        account_type_id: "MLM_LEVEL_INCOME"
      });
      console.log("✅ [SYNC] Old commission records cleared.");
    }

    const activeMembers = await MemberModel.find({
      $or: [
        { status: "active" },
        { status: "Active" },
        { package_value: { $gt: 0 } },
        { amount: { $gt: 0 } }
      ]
    });

    console.log(`🔍 [SYNC] Found ${activeMembers.length} active members with package.`);
    let syncedCount = 0;
    const details = [];

    for (const member of activeMembers) {
      const memberId = member.Member_id || member.member_id;
      const sponsorId = member.sponsor_id || member.Sponsor_code || member.introducer;

      if (!sponsorId) continue;

      let packageAmount = Number(member.package_value || member.amount || 0);
      if (isNaN(packageAmount) || packageAmount <= 0) {
        const pkgStr = String(member.spackage || "");
        const match = pkgStr.match(/(\d+)/);
        if (match) packageAmount = Number(match[1]);
      }

      if (packageAmount <= 0) continue;

      // Update sponsor referrals tracking
      await updateSponsorReferrals(sponsorId, memberId).catch(e => console.error("Update referral err:", e));

      // Calculate all 10 levels of commissions without restriction
      const commissions = await calculateCommissions(memberId, sponsorId, packageAmount);
      if (!commissions || commissions.length === 0) continue;

      // Filter out only commissions that already exist (unless force is true)
      let commissionsToProcess = commissions;
      if (!isForce) {
        const missingCommissions = [];
        for (const comm of commissions) {
          const existingLevelTx = await TransactionModel.findOne({
            member_id: { $in: [comm.sponsor_id, comm.Sponsor_code].filter(Boolean) },
            level: comm.level,
            $or: [
              { related_member_id: memberId },
              { related_member_name: member.Name || member.name },
              { description: new RegExp(`member ${memberId}`, 'i') }
            ]
          });
          if (!existingLevelTx) {
            missingCommissions.push(comm);
          }
        }
        commissionsToProcess = missingCommissions;
      }

      if (commissionsToProcess.length > 0) {
        console.log(`⚡ [SYNC] Processing ${commissionsToProcess.length} commissions for Member: ${memberId} (Pkg: ₹${packageAmount})...`);
        const results = await processCommissions(commissionsToProcess);
        syncedCount++;
        details.push({
          memberId,
          packageAmount,
          sponsorId,
          commissionsCount: commissionsToProcess.length,
          results
        });
      }
    }

    // When force recalculation runs, sync each member's earning_wallet balance with actual completed transactions
    if (isForce) {
      const allMembers = await MemberModel.find({});
      for (const m of allMembers) {
        const mId = m.Member_id || m.member_id;
        const mNumeric = parseInt(mId.replace(/[^0-9]/g, ''), 10);
        const pad5 = !isNaN(mNumeric) ? String(mNumeric).padStart(5, '0') : mId;
        const pad6 = !isNaN(mNumeric) ? String(mNumeric).padStart(6, '0') : mId;
        const possibleIds = [mId, mId.replace('BMS', ''), `BMS${pad5}`, `BMS${pad6}`, pad5, pad6];

        const mCredits = await TransactionModel.find({
          member_id: { $in: possibleIds },
          status: "Completed",
          $or: [
            { transaction_type: { $in: ["Referral Bonus", "Product Level Income", "Level Income"] } },
            { description: { $regex: /referral|level \d+ income|product level/i } }
          ]
        });
        const totalCredited = mCredits.reduce((sum, tx) => sum + (parseFloat(tx.ew_credit) || 0), 0);
        const mDebits = await TransactionModel.find({
          member_id: { $in: possibleIds },
          transaction_type: { $regex: /earning withdrawal/i },
          status: { $in: ["Completed", "Pending", "Processing"] }
        });
        const totalDebited = mDebits.reduce((sum, tx) => sum + (parseFloat(tx.gross_amount) || parseFloat(tx.ew_debit) || 0), 0);
        const newBalance = Math.max(0, totalCredited - totalDebited);
        await MemberModel.updateOne({ _id: m._id }, { $set: { earning_wallet: newBalance } });
      }
    }

    console.log(`🎉 [SYNC] Successfully synced commissions for ${syncedCount} members!`);

    const resultData = {
      success: true,
      message: `Successfully synced missing commissions for ${syncedCount} members.`,
      syncedCount,
      details
    };

    if (res && typeof res.status === "function") {
      return res.status(200).json(resultData);
    }
    return resultData;
  } catch (error) {
    console.error("❌ [SYNC] Error syncing commissions:", error);
    if (res && typeof res.status === "function") {
      return res.status(500).json({ success: false, error: error.message });
    }
    return { success: false, error: error.message };
  }
}

module.exports = {
  triggerMLMCommissions,
  updateReferralHierarchy,
  getMemberCommissionSummary,
  getDailyPayout,
  climeRewardLoan,
  getRewardLoansByStatus,
  processRewardLoan,
  repaymentLoan,
  triggerDailyROI,
  triggerUserROI,
  getROIBenefits,
  getROISummary,
  getLevelRoiSchedules,
  cleanDuplicateReferralBonus,
  syncAllMissingCommissions
};
