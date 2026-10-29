const GlobalIncomeQueue = require("../../models/Packages/GlobalIncomeQueue");
const MemberModel = require("../../models/Users/Member");
const TransactionModel = require("../../models/Transaction/Transaction");

/**
 * Handles adding a member to the Global Income queue (Bundles) and distributing 1.5% payouts
 * to the previous 100 members in the same bundle.
 * 
 * @param {string} memberId - The ID of the member who just bought the package.
 * @param {number} packageAmount - The amount of the package purchased.
 */
const distributeGlobalIncome = async (memberId, packageAmount) => {
  try {
    const amount = Number(packageAmount);
    if (isNaN(amount) || amount <= 0) return;

    // Determine bundle based on exact values or ranges.
    // Bundle 1: 10000, 25000
    // Bundle 2: 50000, 100000
    // Bundle 3: 200000, 500000
    let bundleName = null;
    if (amount === 10000) {
      bundleName = "Bundle_10k";
    } else if (amount === 25000) {
      bundleName = "Bundle_25k";
    } else if (amount === 50000) {
      bundleName = "Bundle_50k";
    } else if (amount === 100000) {
      bundleName = "Bundle_100k";
    } else if (amount === 200000) {
      bundleName = "Bundle_200k";
    } else if (amount === 500000) {
      bundleName = "Bundle_500k";
    } else {
      // If it doesn't fit in bundles, skip Global Income.
      console.log(`[GlobalIncome] Package amount ₹${amount} does not belong to a bundle. Skipping Global Income.`);
      return;
    }

    // Get the current highest queue index for this bundle
    const lastQueueEntry = await GlobalIncomeQueue.findOne({ bundle_name: bundleName })
      .sort({ queue_index: -1 })
      .exec();

    let newQueueIndex = 1;
    if (lastQueueEntry && lastQueueEntry.queue_index) {
      newQueueIndex = lastQueueEntry.queue_index + 1;
    }

    // Add the new purchase to the queue
    const newEntry = new GlobalIncomeQueue({
      member_id: memberId,
      package_amount: amount,
      bundle_name: bundleName,
      queue_index: newQueueIndex
    });
    await newEntry.save();

    console.log(`[GlobalIncome] Member ${memberId} added to queue for ₹${amount} in ${bundleName} at index ${newQueueIndex}`);

    // Distribute 1.5% to the 100 immediately preceding users in the SAME bundle.
    // This loops from newQueueIndex - 1 down to newQueueIndex - 100.
    const startTarget = Math.max(1, newQueueIndex - 100);
    const endTarget = newQueueIndex - 1;

    if (endTarget < 1) return; // No previous members in the queue yet.

    const beneficiaries = await GlobalIncomeQueue.find({
      bundle_name: bundleName,
      queue_index: { $gte: startTarget, $lte: endTarget },
      member_id: { $ne: memberId } // Exclude the purchaser from earning from their own purchase
    });

    for (const beneficiaryEntry of beneficiaries) {
      if (beneficiaryEntry && beneficiaryEntry.member_id) {
        const beneficiaryId = beneficiaryEntry.member_id;
        
        // Payout is 0.2% of the NEW buyer's package amount.
        const payoutAmount = Number((amount * 0.002).toFixed(2));

        // 100% to Vendor Sale Value Wallet (vw_credit)
        const mainWalletAmount = payoutAmount;

        // Distribute 100% to Vendor Wallet
        await MemberModel.findOneAndUpdate(
          { Member_id: beneficiaryId },
          { 
            $inc: { 
              vendor_wallet: mainWalletAmount,
              global_income: payoutAmount // Track total global income
            } 
          }
        );

        // Generate a fast random txId to prevent DB bottlenecks
        const txId = "GI" + Date.now().toString() + Math.floor(1000 + Math.random() * 9000).toString();

        // Record the transaction matching vendor wallet (100% vw_credit)
        const transaction = new TransactionModel({
          transaction_id: txId,
          transaction_date: new Date(),
          member_id: beneficiaryId,
          description: `Global Income (₹${beneficiaryEntry.package_amount}) from ${memberId}'s investment`,
          transaction_type: "Global Income",
          vw_credit: mainWalletAmount.toString(),
          ew_credit: "0",
          tw_credit: "0",
          fd_credit: "0",
          ew_debit: "0",
          uw_credit: "0",
          uw_debit: "0",
          pw_credit: "0",
          status: "Completed",
          net_amount: payoutAmount,
          gross_amount: payoutAmount
        });

        await transaction.save();

        console.log(`[GlobalIncome] Paid ₹${payoutAmount} to ${beneficiaryId} for their ₹${beneficiaryEntry.package_amount} package`);
      }
    }

  } catch (error) {
    console.error("❌ Error in distributeGlobalIncome:", error);
  }
};

module.exports = { distributeGlobalIncome };
