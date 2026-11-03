const MemberModel = require("../../../models/Users/Member");
const AddOnPackageModel = require("../../../models/Packages/AddOnPackage");
const TransactionModel = require("../../../models/Transaction/Transaction");

/**
 * Checks and updates sponsor's level and continuous ROI schedule
 * based on the sum of direct referrals' investments.
 * 
 * Level Multiplier Rules (Compared to Sponsor's total investment):
 * - M >= 8 -> Level 8 (Duration: 100 days)
 * - M >= 7 -> Level 7 (Duration: 100 days)
 * - M >= 6 -> Level 6 (Duration: 100 days)
 * - M >= 5 -> Level 5 (Duration: 100 days)
 * - M >= 4 -> Level 4 (Duration: 100 days)
 * - M >= 3 -> Level 3 (Duration: 100 days)
 * - M >= 2 -> Level 2 (Duration: 100 days)
 * - M >= 1 -> Level 1 (Duration: 150 days)
 * - M < 1  -> Level 0 (Duration: 200 days)
 * 
 * Continuous ROI Rule (Option 1):
 * - If promoted to Level 1: Remaining ROI is divided into 150 days (Target = 150, Count = 0).
 * - If promoted to Level 2+: Remaining ROI is divided into 100 days (Target = 100, Count = 0).
 * - If already Level 2+ and promoted to higher levels (e.g. 2 -> 3..8), level updates,
 *   maintaining the active 100 days ROI schedule.
 * 
 * @param {string} sponsorIdentifier - Member_id, member_code, mobileno, etc.
 */
const checkAndUpdateSponsorLevel = async (sponsorIdentifier) => {
  try {
    if (!sponsorIdentifier) return null;

    const sponsor = await MemberModel.findOne({
      $or: [
        { Member_id: sponsorIdentifier },
        { member_id: sponsorIdentifier },
        { member_code: sponsorIdentifier },
        { mobileno: sponsorIdentifier }
      ]
    });

    if (!sponsor) {
      console.log(`ℹ️ [SponsorLevel] Sponsor not found for identifier: ${sponsorIdentifier}`);
      return null;
    }

    // 1. Calculate sponsor's total investment
    const sponsorPkg = Number(sponsor.package_value) || 0;
    const sponsorAddons = await AddOnPackageModel.find({
      member_id: sponsor.Member_id,
      roi_status: { $ne: "Rejected" },
      request_id: { $ne: "PRIMARY" }
    });
    const sponsorAddonTotal = sponsorAddons.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
    const sponsorTotalInvestment = sponsorPkg + sponsorAddonTotal;

    if (sponsorTotalInvestment <= 0) {
      console.log(`ℹ️ [SponsorLevel] Sponsor ${sponsor.Member_id} has no active investment. Skipping level promotion.`);
      return null;
    }

    // 2. Find all direct referrals of this sponsor
    const sponsorIds = [
      sponsor.Member_id,
      sponsor.member_id,
      sponsor.member_code,
      sponsor.mobileno
    ].filter(Boolean);

    const directReferrals = await MemberModel.find({
      $or: [
        { Sponsor_code: { $in: sponsorIds } },
        { sponsor_id: { $in: sponsorIds } }
      ]
    });

    // 3. Sum total investment of all direct referrals
    let totalDirectInvestment = 0;
    for (const ref of directReferrals) {
      const refPkg = Number(ref.package_value) || 0;
      const refAddons = await AddOnPackageModel.find({
        member_id: ref.Member_id,
        roi_status: { $ne: "Rejected" },
        request_id: { $ne: "PRIMARY" }
      });
      const refAddonTotal = refAddons.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
      totalDirectInvestment += (refPkg + refAddonTotal);
    }

    console.log(`📊 [SponsorLevel] Sponsor ${sponsor.Member_id}: Own Investment = ₹${sponsorTotalInvestment}, Directs Total = ₹${totalDirectInvestment}`);

    // 4. Calculate eligible level based on multiplier
    let eligibleLevel = 0;
    let targetDays = 400;

    if (totalDirectInvestment >= 8 * sponsorTotalInvestment) {
      eligibleLevel = 8;
      targetDays = 100;
    } else if (totalDirectInvestment >= 7 * sponsorTotalInvestment) {
      eligibleLevel = 7;
      targetDays = 100;
    } else if (totalDirectInvestment >= 6 * sponsorTotalInvestment) {
      eligibleLevel = 6;
      targetDays = 100;
    } else if (totalDirectInvestment >= 5 * sponsorTotalInvestment) {
      eligibleLevel = 5;
      targetDays = 100;
    } else if (totalDirectInvestment >= 4 * sponsorTotalInvestment) {
      eligibleLevel = 4;
      targetDays = 100;
    } else if (totalDirectInvestment >= 3 * sponsorTotalInvestment) {
      eligibleLevel = 3;
      targetDays = 100;
    } else if (totalDirectInvestment >= 2 * sponsorTotalInvestment) {
      eligibleLevel = 2;
      targetDays = 100;
    } else if (totalDirectInvestment >= 1 * sponsorTotalInvestment) {
      eligibleLevel = 1;
      targetDays = 150;
    }

    const currentLevel = Number(sponsor.level) || 0;

    // Only promote if eligibleLevel is strictly greater than currentLevel
    if (eligibleLevel <= currentLevel) {
      console.log(`ℹ️ [SponsorLevel] Sponsor ${sponsor.Member_id} is already at Level ${currentLevel} (Eligible: ${eligibleLevel}). No promotion needed.`);
      return { promoted: false, currentLevel, eligibleLevel };
    }

    // 5. Promotion triggered! Calculate total paid so far and remaining ROI
    let totalPaidSoFar = Number(sponsor.roi_total_paid) || 0;

    // Check historical transactions if roi_total_paid is 0
    if (totalPaidSoFar === 0) {
      const historicalTxs = await TransactionModel.find({
        member_id: sponsor.Member_id,
        $or: [
          { transaction_type: "Daily Incentive" },
          { benefit_type: "Daily Incentive" },
          { benefit_type: "ROI" },
          { transaction_type: "ROI Payout" }
        ],
        status: "Completed"
      });
      totalPaidSoFar = historicalTxs.reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || parseFloat(tx.gross_amount) || 0), 0);
    }

    const totalTargetRoi = sponsorTotalInvestment * 2;
    const remainingRoi = Math.max(0, totalTargetRoi - totalPaidSoFar);

    console.log(`🎯 [SponsorLevel] Promoting ${sponsor.Member_id} from Level ${currentLevel} -> Level ${eligibleLevel}!`);
    console.log(`💰 [SponsorLevel] Total Expected ROI: ₹${totalTargetRoi}, Paid So Far: ₹${totalPaidSoFar}, Remaining: ₹${remainingRoi}`);

    // If remaining ROI is > 0 and transitioning duration
    // Level 0 -> 1 (150 days)
    // Level 0 or 1 -> 2+ (100 days)
    if (remainingRoi > 0 && currentLevel < 2) {
      const newDailyRoi = Math.round((remainingRoi / targetDays) * 100) / 100;
      sponsor.roi_daily_amount = newDailyRoi;
      sponsor.roi_payout_target = targetDays; // Option 1: 150 or 100
      sponsor.roi_payout_count = 0;           // Option 1: fresh count for this target
      sponsor.roi_status = "Active";
      console.log(`⏱️ [SponsorLevel] New ROI Schedule: ₹${newDailyRoi}/day for ${targetDays} days.`);
    }

    sponsor.level = eligibleLevel;
    sponsor.roi_total_paid = totalPaidSoFar;
    await sponsor.save();

    console.log(`✅ [SponsorLevel] Sponsor ${sponsor.Member_id} successfully promoted to Level ${eligibleLevel}!`);
    return {
      promoted: true,
      previousLevel: currentLevel,
      newLevel: eligibleLevel,
      targetDays,
      dailyAmount: sponsor.roi_daily_amount
    };

  } catch (error) {
    console.error("❌ [SponsorLevel] Error updating sponsor level:", error.message || error);
    return null;
  }
};

module.exports = { checkAndUpdateSponsorLevel };
