const MemberModel = require("../../../models/Users/Member");
const PayoutModel = require("../../../models/Payout/Payout");
const TransactionModel = require("../../../models/Transaction/Transaction");
const CommissionModel = require("../../../models/commission.model");
const LevelRoiScheduleModel = require("../../../models/Packages/LevelRoiSchedule");
const moment = require("moment");

const levelRoiPercentages = {
  1: 10,
  2: 3,
  3: 2,
  4: 1,
  5: 1,
  6: 1,
  7: 1
};

const referralCommissionPercentages = {
  1: 10,
  2: 3,
  3: 2,
  4: 1,
  5: 1,
  6: 1,
  7: 1,
  8: 0.5,
  9: 0.5,
  10: 0.5
};

const levelBenefitsPercentages = {
  1: 10,
  2: 3,
  3: 2,
  4: 1,
  5: 1,
  6: 1,
  7: 1,
  8: 0.5,
  9: 0.5,
  10: 0.5
};

/*
const roiCommissionPercentages = {
  1: 20,
  2: 3,
  3: 1,
  4: 1,
  5: 1,
  6: 1,
  7: 1,
  8: 1,
  9: 1,
  10: 1
};
*/

const getOrdinal = (number) => {
  const suffixes = ["th", "st", "nd", "rd"];
  const value = number % 100;
  return number + (suffixes[(value - 20) % 10] || suffixes[value] || suffixes[0]);
};

const findUplineSponsors = async (memberId, maxLevels = 15) => {
  const uplineSponsors = [];
  const visited = new Set([String(memberId)]);
  let currentMemberId = memberId;
  let level = 0;

  while (level < maxLevels) {
    const currentMember = await MemberModel.findOne({
      $or: [{ Member_id: currentMemberId }, { member_id: currentMemberId }]
    });

    const sponsorIdentifier = currentMember?.sponsor_id || currentMember?.Sponsor_code || currentMember?.introducer;
    if (!currentMember || !sponsorIdentifier || String(sponsorIdentifier) === String(currentMemberId)) {
      break; // No more sponsors or self-referral
    }

    const sponsor = await MemberModel.findOne({
      $or: [{ Member_id: sponsorIdentifier }, { member_id: sponsorIdentifier }, { member_code: sponsorIdentifier }, { mobileno: sponsorIdentifier }]
    });
    if (!sponsor) {
      break; // Sponsor not found
    }

    const sponsorActualId = String(sponsor.Member_id || sponsor.member_id);
    if (visited.has(sponsorActualId)) {
      console.warn(`⚠️ Circular referral detected in upline tree at level ${level + 1} for ${sponsorActualId}. Stopping tree traversal.`);
      break;
    }
    visited.add(sponsorActualId);

    level++;
    uplineSponsors.push({
      level: level,
      sponsor_id: sponsor.Member_id || sponsor.member_id,
      Sponsor_code: sponsor.member_code || sponsor.Member_id,
      sponsor_name: sponsor.Name || sponsor.name,
      sponsor_mobileno: sponsor.mobileno || sponsor.contactno,
      sponsored_member_id: currentMemberId, // The member who triggered this commission
      sponsor_status: sponsor.status,
      sponsor_level: Number(sponsor.level) || 0
    });

    // Move up the chain
    currentMemberId = sponsor.Member_id || sponsor.member_id;
  }

  return uplineSponsors;
};


const calculateCommissions = async (newMemberId, directSponsorId, specificAmount = null, pkgType = "Base") => {
  try {
    // Find the new member
    const newMember = await MemberModel.findOne({ Member_id: newMemberId });
    if (!newMember) {
      console.error(`❌ New member ${newMemberId} not found for commission calculation`);
      return [];
    }

    const packageValue = specificAmount !== null ? specificAmount : Number(newMember.package_value || newMember.spackage || 0);
    if (!packageValue || packageValue <= 0) {
      console.log(`⚠️ New member ${newMemberId} has invalid package amount: ${packageValue}`);
      return [];
    }


    // Find all upline sponsors up to 10 levels
    const uplineSponsors = await findUplineSponsors(newMemberId, 10);

    if (uplineSponsors.length === 0) {
      return [];
    }

    const commissions = [];

    // Process each upline sponsor
    for (const upline of uplineSponsors) {
      // Only active sponsors are eligible for commissions (case-insensitive)
      const isActive = String(upline.sponsor_status || "").toLowerCase() === "active";
      if (!isActive) {
        continue;
      }

      const sponsorLevel = Number(upline.sponsor_level) || 0;

      // --- 1. Calculate Referral Level Income (Direct - Level 1) ---
      // Direct income flow keeps same, no member level requirement
      const refPercentage = referralCommissionPercentages[upline.level] || 0;
      if (refPercentage > 0 && upline.level === 1) {
        const refAmount = Number(((packageValue * refPercentage) / 100).toFixed(2));
        if (refAmount > 0) {
          commissions.push({
            level: upline.level,
            sponsor_id: upline.sponsor_id,
            Sponsor_code: upline.Sponsor_code,
            sponsor_name: upline.sponsor_name,
            sponsor_mobileno: upline.sponsor_mobileno,
            sponsored_member_id: upline.sponsored_member_id,
            new_member_id: newMemberId,
            new_member_name: newMember.Name,
            amount: refAmount,
            percentage: refPercentage,
            packageValue: packageValue,
            payout_type: `Level ${upline.level} Referral Bonus (Invest Amount)`,
            description: `Level ${upline.level} Referral commission (${refPercentage}%) from member ${newMemberId}'s investment (₹${packageValue})`,
            sponsor_status: upline.sponsor_status
          });
          console.log(`✅ [REFERRAL BONUS] Level ${upline.level}: ${upline.sponsor_name} (${upline.sponsor_id}) gets ₹${refAmount} (${refPercentage}%)`);
        }
      }

      // --- 2. Calculate Level Benefits Income (Level 2 to 10) ---
      const levelPercentage = levelBenefitsPercentages[upline.level] || 0;
      if (levelPercentage > 0 && upline.level > 1) {
        // Eligibility rule:
        // - Level 2, 3, 4, 5: Member level must be at least 4 (>= 4). Otherwise skip.
        // - Level 6, 7, 8, 9, 10: Member level must be at least 8 (>= 8). Otherwise skip.
        if (upline.level >= 2 && upline.level <= 5 && sponsorLevel < 4) {
          console.log(`⏭️ [LEVEL BONUS SKIPPED] Level ${upline.level}: ${upline.sponsor_name} (${upline.sponsor_id}) has level ${sponsorLevel} (Requires Level >= 4). Commission skipped.`);
          continue;
        }

        if (upline.level >= 6 && upline.level <= 10 && sponsorLevel < 8) {
          console.log(`⏭️ [LEVEL BONUS SKIPPED] Level ${upline.level}: ${upline.sponsor_name} (${upline.sponsor_id}) has level ${sponsorLevel} (Requires Level >= 8). Commission skipped.`);
          continue;
        }

        const levelAmount = Number(((packageValue * levelPercentage) / 100).toFixed(2));
        if (levelAmount > 0) {
          commissions.push({
            level: upline.level,
            sponsor_id: upline.sponsor_id,
            Sponsor_code: upline.Sponsor_code,
            sponsor_name: upline.sponsor_name,
            sponsor_mobileno: upline.sponsor_mobileno,
            sponsored_member_id: upline.sponsored_member_id,
            new_member_id: newMemberId,
            new_member_name: newMember.Name,
            amount: levelAmount,
            percentage: levelPercentage,
            packageValue: packageValue,
            payout_type: `Product Level ${upline.level} Income`,
            description: `Product Level Income - Level ${upline.level} (${levelPercentage}%) from member ${newMemberId}'s investment (₹${packageValue})`,
            sponsor_status: upline.sponsor_status
          });
          console.log(`✅ [LEVEL BONUS] Level ${upline.level}: ${upline.sponsor_name} (${upline.sponsor_id}) gets ₹${levelAmount} (${levelPercentage}%)`);
        }
      }
    }

    return commissions;

  } catch (error) {
    console.error("❌ Error calculating commissions:", error);
    throw error;
  }
};

/**
 * Processes commissions by creating payouts and transactions for each eligible sponsor
 * 
 * @param {Array} commissions - Array of commission objects from calculateCommissions
 * @returns {Array} Array of results with success/failure status for each commission
 */
const processCommissions = async (commissions, session = null) => {
  try {
    const results = [];

    for (const commission of commissions) {
      try {
        // Verify sponsor is still active before processing
        const sponsor = await MemberModel.findOne({ Member_id: commission.sponsor_id }).session(session);

        if (!sponsor || sponsor.status !== 'active') {
          results.push({
            success: false,
            level: commission.level,
            sponsor_id: commission.sponsor_id,
            sponsor_name: commission.sponsor_name,
            error: `Sponsor status is not active (${sponsor?.status || 'not found'})`
          });
          continue;
        }

        // Safety verification of sponsor level eligibility
        const sponsorLevel = Number(sponsor.level) || 0;
        if (commission.level >= 2 && commission.level <= 5 && sponsorLevel < 4) {
          results.push({
            success: false,
            level: commission.level,
            sponsor_id: commission.sponsor_id,
            sponsor_name: commission.sponsor_name,
            error: `Sponsor level ${sponsorLevel} is not eligible for Level ${commission.level} commission (Requires Level >= 4)`
          });
          continue;
        }

        if (commission.level >= 6 && commission.level <= 10 && sponsorLevel < 8) {
          results.push({
            success: false,
            level: commission.level,
            sponsor_id: commission.sponsor_id,
            sponsor_name: commission.sponsor_name,
            error: `Sponsor level ${sponsorLevel} is not eligible for Level ${commission.level} commission (Requires Level >= 8)`
          });
          continue;
        }

        // Generate unique payout ID
        const payoutId = Date.now() + Math.floor(Math.random() * 1000) + commission.level + Math.floor(Math.random() * 1000);

        // Create payout record
        const payout = new PayoutModel({
          payout_id: payoutId.toString(),
          date: new Date().toISOString().split('T')[0],
          memberId: commission.sponsor_id,
          payout_type: commission.payout_type,
          ref_no: commission.new_member_id,
          amount: commission.amount,
          level: commission.level,
          sponsored_member_id: commission.new_member_id,
          sponsor_id: commission.sponsor_id,
          status: "Completed",
          Name: sponsor.Name,
          mobileno: sponsor.mobileno,
          description: commission.description,
          sponsor_status: commission.sponsor_status
        });

        await payout.save({ session });

        // Create transaction record for wallet credit
        const transaction = await createLevelBenefitsTransaction({
          payout_id: payoutId.toString(),
          memberId: commission.sponsor_id,
          payout_type: commission.payout_type,
          amount: commission.amount,
          level: commission.level,
          new_member_id: commission.new_member_id,
          new_member_name: commission.new_member_name,
          sponsor_name: sponsor.Name,
          sponsor_mobileno: sponsor.mobileno
        }, session);

        // Create commission record
        const commissionRecord = new CommissionModel({
          commission_id: `COM-${payoutId}`,
          beneficiary_id: commission.sponsor_id,
          beneficiary_name: sponsor.Name || commission.sponsor_name,
          beneficiary_type: "MEMBER",
          source_id: commission.new_member_id,
          source_name: commission.new_member_name,
          source_type: "MEMBER",
          transaction_id: transaction.transaction_id,
          transaction_date: new Date(),
          account_type: commission.payout_type,
          account_type_id: "MLM_LEVEL_INCOME",
          transaction_amount: commission.packageValue || 0,
          commission_rate: commission.percentage || 0,
          commission_amount: commission.amount,
          level: commission.level,
          status: "CREDITED",
          credited_at: new Date()
        });

        await commissionRecord.save({ session });

        results.push({
          success: true,
          level: commission.level,
          amount: commission.amount
        });

      } catch (error) {
        console.error(`❌ Error processing commission for level ${commission.level} (${commission.sponsor_id}):`, error);
        results.push({
          success: false,
          error: error.message
        });
      }
    }

    return results;

  } catch (error) {
    console.error("❌ Error in processCommissions:", error);
    throw error;
  }
};

const createLevelBenefitsTransaction = async (transactionData, session = null) => {
  try {
    const { payout_id, memberId, payout_type, amount, level, new_member_id, new_member_name, sponsor_name, sponsor_mobileno } = transactionData;

    // Fixed: Performance optimization - don't query for last ID on every iteration
    // Use a unique compound ID to ensure consistency and speed in high-concurrency 
    const newTransactionId = `T-L-${payout_id}-${Math.floor(Math.random() * 1000)}`;

    // 100% Vendor Sale Value Wallet (vendor_wallet / vw_credit)
    const commissionAmount = Number(amount.toFixed(2));

    const transaction = new TransactionModel({
      transaction_id: newTransactionId,
      transaction_date: new Date(),
      member_id: memberId,
      Name: sponsor_name,
      mobileno: sponsor_mobileno,
      reference_no: (payout_id || '').toString(),
      description: payout_type,
      transaction_type: payout_type.includes('Referral Bonus') ? "Referral Bonus" : "Product Level Income",
      vw_credit: commissionAmount.toString(),
      ew_credit: "0",
      tw_credit: "0",
      uw_credit: "0",
      fd_credit: "0",
      pw_credit: "0",
      ew_debit: "0",
      status: "Completed",
      level: level,
      benefit_type: level === 1 ? "direct" : "indirect",
      related_member_id: new_member_id,
      related_member_name: new_member_name,
      related_payout_id: payout_id
    });

    await transaction.save({ session });

    // Add full commission amount to sponsor's vendor sale value wallet
    await MemberModel.findOneAndUpdate(
      { Member_id: memberId },
      { 
        $inc: {
          vendor_wallet: commissionAmount
        } 
      },
      { session }
    );

return transaction;

  } catch (error) {
  console.error("❌ Error creating transaction:", error);
  throw error;
}
};

const updateSponsorReferrals = async (sponsorId, newMemberId) => {
  try {
    const sponsorQuery = { $or: [{ Member_id: sponsorId }, { member_id: sponsorId }] };
    const sponsor = await MemberModel.findOne(sponsorQuery);
    if (!sponsor) {
      console.error(`Sponsor not found: ${sponsorId}`);
      return;
    }
    await MemberModel.findOneAndUpdate(
      sponsorQuery,
      {
        $addToSet: { direct_referrals: newMemberId },
        $inc: { total_team: 1 }
      }
    );

console.log(`✅ Updated referrals for ${sponsorId}: Added ${newMemberId}`);

  } catch (error) {
  console.error("❌ Error updating referrals:", error);
  throw error;
}
};

const getUplineTree = async (memberIdOrReq, maxLevelsOrRes = 15) => {
  const isExpressHandler = Boolean(
    memberIdOrReq &&
    typeof memberIdOrReq === 'object' &&
    memberIdOrReq.params !== undefined &&
    maxLevelsOrRes &&
    typeof maxLevelsOrRes.json === 'function'
  );

  let memberId;
  let maxLevels = 15;
  let res = null;

  if (isExpressHandler) {
    const req = memberIdOrReq;
    res = maxLevelsOrRes;
    memberId = req.params?.id || req.user?.memberId;
  } else {
    memberId = memberIdOrReq;
    maxLevels = typeof maxLevelsOrRes === 'number' ? maxLevelsOrRes : 15;
  }

  try {
    const uplines = await findUplineSponsors(memberId, maxLevels);
    const tree = uplines.map((u) => {
      const rate = u.level === 1
        ? (referralCommissionPercentages[1] || 0)
        : (levelBenefitsPercentages[u.level] || 0);

      const isActive = String(u.sponsor_status || "").toLowerCase() === "active";
      const sponsorLvl = Number(u.sponsor_level) || 0;
      let eligible = isActive;
      if (u.level >= 2 && u.level <= 5 && sponsorLvl < 4) eligible = false;
      if (u.level >= 6 && u.level <= 10 && sponsorLvl < 8) eligible = false;

      return {
        level: u.level,
        member_id: u.sponsor_id,
        name: u.sponsor_name,
        member_code: u.Sponsor_code,
        status: u.sponsor_status,
        member_level: sponsorLvl,
        commission_rate: rate,
        eligible: eligible
      };
    });

    if (isExpressHandler) {
      return res.status(200).json({ success: true, data: tree });
    }
    return tree;
  } catch (error) {
    console.error("❌ Error getting upline tree:", error);
    if (isExpressHandler) {
      return res.status(500).json({ success: false, message: error.message });
    }
    return [];
  }
};

const getCommissionSummary = () => {
  return {
    total_levels: 10,
    referral_rates: referralCommissionPercentages,
    level_rates: levelBenefitsPercentages,
    // roi_rates: roiCommissionPercentages, // Disabled as per user request (NO ROI)
    condition: "Level 1: Active status required. Level 2-5: Active status & Member Level >= 4 required. Level 6-10: Active status & Member Level >= 8 required."
  };
};

const processMemberActivation = async (activatedMemberId) => {
  return { success: false, message: "Commissions Disabled" };
  /*
  try {
    const member = await MemberModel.findOne({ Member_id: activatedMemberId });
    if (!member) {
      return { success: false, message: "Member not found" };
    }

    let sponsor = null;
    if (member.sponsor_id) {
      sponsor = await MemberModel.findOne({ Member_id: member.sponsor_id });
    }

    if (!sponsor) {
      return { success: false, message: "Sponsor not found" };
    }

    if (sponsor.status !== "active") {
      await updateSponsorReferrals(sponsor.Member_id, member.Member_id).catch(e => console.error(e));
      return { success: false, message: "Sponsor not active; payout skipped" };
    }

    const amount = commissionRates[1] || 0;
    if (amount <= 0) {
      return { success: false, message: "No commission configured for level 1" };
    }

    const payoutId = Date.now() + Math.floor(Math.random() * 1000) + 1;

    const payout = new PayoutModel({
      payout_id: payoutId,
      date: new Date().toISOString().split("T")[0],
      memberId: sponsor.Member_id,
      payout_type: `1st Level Benefits`,
      ref_no: member.Member_id,
      amount: amount,
      level: 1,
      sponsored_member_id: member.Member_id,
      sponsor_id: sponsor.Member_id,
      status: "Completed",
      description: `Direct referral commission from ${member.Member_id}`
    });

    await payout.save();

    const transaction = await createLevelBenefitsTransaction({
      payout_id: payoutId,
      memberId: sponsor.Member_id,
      payout_type: payout.payout_type,
      amount: amount,
      level: 1,
      new_member_id: member.Member_id
    });

    await updateSponsorReferrals(sponsor.Member_id, member.Member_id);

    return {
      success: true,
      payout,
      transaction
    };

  } catch (error) {
    console.error("❌ Error in processMemberActivation:", error);
    throw error;
  }
  */
};

/**
 * Distributes commission to 10 levels of upline sponsors when a member receives ROI
 * 
 * @param {string} memberId - The member ID who received ROI
 * @param {number} roiAmount - The ROI amount received
 * @returns {Promise<Array>} Results of commission distribution
 */
/* DISABLED AS PER USER REQUEST (NO ROI)
const distributeROICommission = async (memberId, roiAmount, session = null, customDate = null, sourceRef = "Base") => {
  try {
    if (!roiAmount || roiAmount <= 0) return [];

    // Find the source member to get their name
    const sourceMember = await MemberModel.findOne({ Member_id: memberId }).session(session);
    if (!sourceMember) return [];

    // Find all upline sponsors up to 10 levels
    const uplineSponsors = await findUplineSponsors(memberId, 10);
    if (uplineSponsors.length === 0) return [];

    const results = [];

    for (const upline of uplineSponsors) {
      // Only active sponsors are eligible for commissions
      if (upline.sponsor_status !== 'active') {
        results.push({
          level: upline.level,
          sponsor_id: upline.sponsor_id,
          success: false,
          error: "Sponsor not active"
        });
        continue;
      }

      // Get percentage based on level
      const percentage = roiCommissionPercentages[upline.level] || 0;
      if (percentage <= 0) continue;

      const commissionAmount = Number(((roiAmount * percentage) / 100).toFixed(2));
      if (commissionAmount <= 0) continue;

      const payoutId = Date.now() + Math.floor(Math.random() * 1000) + upline.level + Math.floor(Math.random() * 1000);
      const today = customDate || new Date().toISOString().split('T')[0];

      // Create payout record
      const payout = new PayoutModel({
        payout_id: payoutId.toString(),
        date: today,
        memberId: upline.sponsor_id,
        payout_type: "ROI Level Benefit",
        // ✅ FIXED: ref_no must be unique per day/member/level/source to avoid DB collision
        ref_no: `ROI-L-${memberId}-${upline.level}-${today}-${sourceRef}`,
        amount: commissionAmount,
        level: upline.level,
        sponsored_member_id: memberId,
        sponsor_id: upline.sponsor_id,
        status: "Completed",
        Name: upline.sponsor_name,
        mobileno: upline.sponsor_mobileno,
        description: `ROI Level ${upline.level} benefit (${percentage}%) from member ${memberId}'s ROI (₹${roiAmount})`,
        sponsor_status: upline.sponsor_status
      });

      await payout.save({ session });

      // Fixed: Use unique transaction ID based on payoutId to skip slow DB reads
      const newTransactionId = `T-ROI-L-${payoutId}-${Math.floor(Math.random() * 1000)}`;

      const transaction = new TransactionModel({
        transaction_id: newTransactionId,
        transaction_date: today,
        member_id: upline.sponsor_id,
        Name: upline.sponsor_name,
        mobileno: upline.sponsor_mobileno,
        reference_no: payoutId.toString(),
        description: `ROI Level ${upline.level} Benefit`,
        transaction_type: "ROI Level Benefit",
        ew_credit: commissionAmount.toString(),
        ew_debit: "0",
        status: "Completed",
        level: upline.level,
        benefit_type: "ROI Level Income",
        related_member_id: memberId,
        related_member_name: sourceMember.Name,
        related_payout_id: payoutId
      });

      await transaction.save({ session });

      // Add amount to sponsor's wallet balance
      await MemberModel.findOneAndUpdate(
        { Member_id: upline.sponsor_id },
        { $inc: { wallet_balance: commissionAmount } },
        { session }
      );

      results.push({
        level: upline.level,
        sponsor_id: upline.sponsor_id,
        amount: commissionAmount,
        success: true
      });

      console.log(`💰 ROI Level ${upline.level}: ${upline.sponsor_id} gets ₹${commissionAmount} from ${memberId}`);
    }

    return results;

  } catch (error) {
    console.error("❌ Error in distributeROICommission:", error);
    throw error;
  }
};
*/
const distributeROICommission = async (memberId, roiAmount, session = null, customDate = null, sourceRef = "Base") => {
  return [];
};

/**
 * Creates 50-day Level ROI schedules for upline sponsors up to 7 levels.
 * Eligibility: Sponsor must be active AND have rank level >= 3.
 * 
 * Rates:
 * Level 1: 10% total over 50 days (0.20%/day)
 * Level 2: 3% total over 50 days (0.06%/day)
 * Level 3: 2% total over 50 days (0.04%/day)
 * Level 4 to 7: 1% total over 50 days (0.02%/day each)
 * 
 * @param {string} newMemberId - The newly activated member
 * @param {number} packageAmount - The package investment amount
 * @returns {Array} List of created schedule records
 */
const createLevelRoiSchedules = async (newMemberId, packageAmount) => {
  try {
    if (!packageAmount || Number(packageAmount) <= 0) {
      console.log(`⚠️ Invalid package amount for Level ROI schedules: ${packageAmount}`);
      return [];
    }

    const newMember = await MemberModel.findOne({
      $or: [{ Member_id: newMemberId }, { member_id: newMemberId }]
    });

    if (!newMember) {
      console.error(`❌ Member ${newMemberId} not found for Level ROI schedule creation`);
      return [];
    }

    const uplineSponsors = await findUplineSponsors(newMemberId, 7);
    if (!uplineSponsors || uplineSponsors.length === 0) {
      console.log(`ℹ️ No upline sponsors found for ${newMemberId}`);
      return [];
    }

    const createdSchedules = [];
    const todayStr = moment().utcOffset("+05:30").format("YYYY-MM-DD");

    for (const upline of uplineSponsors) {
      if (upline.level > 7) continue;

      const isActive = String(upline.sponsor_status || "").toLowerCase() === "active";
      const sponsorRank = Number(upline.sponsor_level) || 0;

      // Condition: Active AND Rank Level >= 3 (applies to all 7 levels)
      if (!isActive) {
        console.log(`⏭️ [50-Day Level ROI Skipped] Level ${upline.level}: ${upline.sponsor_name} (${upline.sponsor_id}) is inactive.`);
        continue;
      }

      if (sponsorRank < 3) {
        console.log(`⏭️ [50-Day Level ROI Skipped] Level ${upline.level}: ${upline.sponsor_name} (${upline.sponsor_id}) has Rank Level ${sponsorRank} (Requires Level >= 3).`);
        continue;
      }

      const percentage = levelRoiPercentages[upline.level] || 0;
      if (percentage <= 0) continue;

      const totalAmount = Number(((packageAmount * percentage) / 100).toFixed(2));
      const dailyAmount = Number((totalAmount / 50).toFixed(2));

      if (dailyAmount <= 0) continue;

      const scheduleId = `LROI_${Date.now()}_L${upline.level}_${Math.floor(Math.random() * 1000)}`;

      const schedule = new LevelRoiScheduleModel({
        schedule_id: scheduleId,
        sponsor_id: upline.sponsor_id,
        sponsor_name: upline.sponsor_name,
        sponsor_level: sponsorRank,
        level: upline.level,
        from_member_id: newMemberId,
        from_member_name: newMember.Name || newMember.name,
        package_amount: Number(packageAmount),
        total_percentage: percentage,
        total_amount: totalAmount,
        daily_amount: dailyAmount,
        target_days: 50,
        payout_count: 0,
        total_paid: 0,
        status: "Active",
        start_date: todayStr
      });

      await schedule.save();
      createdSchedules.push(schedule);

      console.log(`✅ [50-Day Level ROI Registered] Level ${upline.level}: ${upline.sponsor_name} (${upline.sponsor_id}) will receive ₹${dailyAmount}/day for 50 days (Total ₹${totalAmount}, ${percentage}% of ₹${packageAmount})`);
    }

    return createdSchedules;
  } catch (error) {
    console.error("❌ Error creating 50-day Level ROI schedules:", error);
    return [];
  }
};

module.exports = {
  referralCommissionPercentages,
  levelBenefitsPercentages,
  commissionRates: levelBenefitsPercentages,
  levelRoiPercentages,
  createLevelRoiSchedules,
  getOrdinal,
  findUplineSponsors,
  createLevelBenefitsTransaction,
  updateSponsorReferrals,
  calculateCommissions,
  processCommissions,
  getUplineTree,
  getCommissionSummary,
  processMemberActivation,
  distributeROICommission
};
