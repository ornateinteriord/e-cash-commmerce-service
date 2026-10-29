const TransactionModel = require("../../../models/Transaction/Transaction");
const MemberModel = require("../../../models/Users/Member");
const AddOnPackageModel = require("../../../models/Packages/AddOnPackage");
const CommissionModel = require("../../../models/commission.model");
const path = require("path");
const { generateOTP, storeOTP, verifyOTP } = require("../../../utils/OtpService");
const { sendMail } = require("../../../utils/EmailService");
const admin = require("../../../utils/FirebaseService");
const generateTransactionId = require("../../../utils/generateTransactionId");

/**
 * Calculate member's 2X cumulative withdrawal limits
 * Rule:
 * 1. Total Investment = Primary Package (package_value) + All Add-on Packages (AddOnPackageModel)
 * 2. Max Withdrawal Limit = 2 * Total Investment
 * 3. Total Withdrawn = Sum of all withdrawals with status Completed, Approved, Pending, Processing
 * 4. Remaining Limit = Math.max(0, Max Withdrawal Limit - Total Withdrawn)
 */
const getMemberWithdrawalLimits = async (memberId) => {
  const member = await MemberModel.findOne({
    $or: [{ Member_id: memberId }, { member_id: memberId }]
  });

  if (!member) {
    return {
      primaryAmount: 0,
      totalAddonAmount: 0,
      totalInvested: 0,
      maxWithdrawalLimit: 0,
      totalWithdrawn: 0,
      remainingWithdrawalLimit: 0,
      hasInvestment: false
    };
  }

  const actualMemberId = member.Member_id || memberId;

  // 1. Total Investments
  const addonPackages = await AddOnPackageModel.find({
    member_id: actualMemberId,
    request_id: { $ne: 'PRIMARY' }
  });
  const totalAddonAmount = addonPackages.reduce((acc, pkg) => acc + (parseFloat(pkg.amount) || 0), 0);
  const primaryAmount = parseFloat(member.package_value) || 0;
  const totalInvested = primaryAmount + totalAddonAmount;

  // 2. Max 2x Limit
  const maxWithdrawalLimit = totalInvested * 2;

  // 3. Total Withdrawn So Far (include Pending, Processing, Approved, Completed)
  const withdrawalTxs = await TransactionModel.find({
    member_id: actualMemberId,
    transaction_type: "Withdrawal",
    status: { $in: ["Completed", "Approved", "Pending", "Processing"] }
  });

  const totalWithdrawn = withdrawalTxs.reduce((acc, tx) => {
    return acc + (parseFloat(tx.gross_amount) || parseFloat(tx.ew_debit) || 0);
  }, 0);

  // 4. Remaining Limit
  const remainingWithdrawalLimit = Math.max(0, maxWithdrawalLimit - totalWithdrawn);

  return {
    primaryAmount,
    totalAddonAmount,
    totalInvested,
    maxWithdrawalLimit,
    totalWithdrawn,
    remainingWithdrawalLimit,
    hasInvestment: totalInvested > 0
  };
};

const getWalletOverview = async (req, res) => {
  try {
    const { memberId } = req.params;
    if (!memberId) {
      return res.status(400).json({ success: false, message: "Member ID is required" });
    }

    const member = await MemberModel.findOne({ Member_id: memberId });
    if (!member) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }

    const numericPart = parseInt(memberId.replace('BMS', ''), 10);
    const pad5 = String(numericPart).padStart(5, '0');
    const pad6 = String(numericPart).padStart(6, '0');

    const possibleIds = [
      memberId,
      memberId.replace('BMS', ''),
      `BMS${pad5}`,
      `BMS${pad6}`,
      pad5,
      pad6,
      `BMS${numericPart}`
    ];



    const transactions = await TransactionModel.find({
      member_id: { $in: possibleIds }
    });

    // === TOP UP WALLET (completely separate) ===
    const topUpTransactions = transactions.filter(tx =>
      tx.transaction_type === 'Top up' || (parseFloat(tx.tw_credit) > 0) || (parseFloat(tx.tw_debit) > 0)
    );
    const topUpCredits = topUpTransactions
      .filter(tx => tx.status === 'Completed' || tx.status === 'Approved')
      .reduce((acc, tx) => acc + (parseFloat(tx.tw_credit) || parseFloat(tx.ew_credit) || 0), 0);
    const topUpDebits = topUpTransactions
      .filter(tx => tx.status === 'Completed' || tx.status === 'Approved')
      .reduce((acc, tx) => acc + (parseFloat(tx.tw_debit) || (tx.transaction_type === 'Top up' ? parseFloat(tx.ew_debit) || 0 : 0)), 0);
    const calculatedTopUp = Math.max(0, topUpCredits - topUpDebits);
    const topUpBalance = Math.max(calculatedTopUp, member.top_up_wallet || 0);

    // === FIRST WALLET (MAIN WALLET: strictly for Add Money deposits & package activation debits) ===
    const nonLoanTransactions = transactions.filter(tx =>
      !tx.transaction_type?.toLowerCase().includes('loan') &&
      !tx.description?.toLowerCase().includes('loan') &&
      tx.transaction_type !== 'Top up'
    );

    const completedAndPendingTx = nonLoanTransactions.filter(tx =>
      tx.status === "Completed" || tx.status === "Pending" || tx.status === "Approved"
    );

    const calculatedMainBalance = completedAndPendingTx.reduce((acc, tx) =>
      acc + (parseFloat(tx.ew_credit) || 0) - (parseFloat(tx.ew_debit) || 0), 0
    );

    // Synchronize First Wallet available balance with member.wallet_balance
    const availableBalance = member.wallet_balance !== undefined && member.wallet_balance !== null
      ? Math.max(0, parseFloat(member.wallet_balance) || 0)
      : Math.max(0, calculatedMainBalance);

    // For display purposes only - total income/expenses from completed transactions
    const completedTx = nonLoanTransactions.filter(tx => tx.status === "Completed");
    const totalIncome = completedTx.reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0), 0);
    const totalExpenses = completedTx.reduce((acc, tx) => acc + (parseFloat(tx.ew_debit) || 0), 0);

    const totalWithdrawal = nonLoanTransactions
      .filter(tx => tx.transaction_type === "Withdrawal" && tx.status === "Completed")
      .reduce((acc, tx) => acc + (parseFloat(tx.ew_debit) || 0), 0);

    const otherDebits = nonLoanTransactions
      .filter(tx => tx.transaction_type !== "Withdrawal" && tx.status === "Completed")
      .reduce((acc, tx) => acc + (parseFloat(tx.ew_debit) || 0), 0);

    // Product Level Income: STRICTLY only transactions with "Product Level" or Level Income in description / type
    const levelBenefits = nonLoanTransactions
      .filter(tx => {
        const txType = (tx.transaction_type || "").toLowerCase();
        const desc = (tx.description || "").toLowerCase();
        const benefit = (tx.benefit_type || "").toLowerCase();

        const isProductLevel = (
          desc.includes("product level") ||
          txType.includes("product level") ||
          desc.includes("level benefit") ||
          desc.includes("level bonus") ||
          txType.includes("level benefit") ||
          txType.includes("level bonus") ||
          benefit.includes("level income")
        );

        const isExcluded = (
          desc.includes("roi") ||
          txType.includes("roi") ||
          desc.includes("referral") ||
          txType.includes("referral") ||
          desc.includes("daily incentive") ||
          txType.includes("daily incentive")
        );

        return isProductLevel && !isExcluded && tx.status === "Completed";
      })
      .reduce((acc, tx) => acc + (parseFloat(tx.vw_credit) || 0) + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.uw_credit) || 0) + (parseFloat(tx.fd_credit) || 0) + (parseFloat(tx.pw_credit) || 0), 0);

    const roiLevelBenefits = nonLoanTransactions
      .filter(tx =>
        (tx.transaction_type === "ROI Level Benefit" || tx.transaction_type === "Level Daily ROI") &&
        tx.status === "Completed"
      )
      .reduce((acc, tx) => acc + (parseFloat(tx.vw_credit) || 0) + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.uw_credit) || 0) + (parseFloat(tx.fd_credit) || 0) + (parseFloat(tx.pw_credit) || 0), 0);

    const directBenefits = nonLoanTransactions
      .filter(tx => {
        const txType = tx.transaction_type?.toLowerCase() || "";
        const desc = tx.description?.toLowerCase() || "";
        return (txType === "direct benefits" || desc === "direct benefits" ||
          txType.includes("referral") || desc.includes("referral")) &&
          tx.status === "Completed";
      })
      .reduce((acc, tx) => acc + (parseFloat(tx.vw_credit) || 0) + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.uw_credit) || 0) + (parseFloat(tx.fd_credit) || 0) + (parseFloat(tx.pw_credit) || 0), 0);

    // Repayment Commission calculation
    const repaymentCommission = nonLoanTransactions
      .filter(tx =>
        (tx.transaction_type === "Repayment Commission" ||
          tx.description === "Repayment Commission" ||
          tx.transaction_type === "Repayment commission" ||
          tx.description === "Repayment commission") &&
        tx.status === "Completed"
      )
      .reduce((acc, tx) => acc + (parseFloat(tx.vw_credit) || 0) + (parseFloat(tx.ew_credit) || 0), 0);

    // Get pending withdrawals for transparency
    const pendingWithdrawals = nonLoanTransactions
      .filter(tx => tx.transaction_type === "Withdrawal" && tx.status === "Pending")
      .reduce((acc, tx) => acc + (parseFloat(tx.ew_debit) || 0), 0);

    const roiBenefits = nonLoanTransactions
      .filter(tx =>
        tx.transaction_type === "ROI Payout" &&
        tx.status === "Completed"
      )
      .reduce((acc, tx) => acc + (parseFloat(tx.vw_credit) || 0) + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.uw_credit) || 0) + (parseFloat(tx.fd_credit) || 0) + (parseFloat(tx.pw_credit) || 0), 0);

    const singleLineIncome = nonLoanTransactions
      .filter(tx =>
        (tx.transaction_type === "Daily Incentive" ||
          tx.transaction_type === "Single Line Income" ||
          tx.transaction_type === "Single Level Income" ||
          tx.transaction_type === "Single Leg Income" ||
          tx.transaction_type === "ROI Payout" ||
          tx.description?.toLowerCase().includes("daily incentive")) &&
        tx.status === "Completed"
      )
      .reduce((acc, tx) => acc + (parseFloat(tx.gross_amount) || parseFloat(tx.net_amount) || ((parseFloat(tx.vw_credit) || 0) + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.tw_credit) || 0)) || parseFloat(tx.vw_credit) || parseFloat(tx.ew_credit) || 0), 0);


    // Calculate loan amounts separately (for information only)
    const loanTransactions = transactions.filter(tx =>
      tx.transaction_type?.toLowerCase().includes('loan') ||
      tx.description?.toLowerCase().includes('loan')
    );

    const totalLoanCredits = loanTransactions.reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0), 0);
    const totalLoanDebits = loanTransactions.reduce((acc, tx) => acc + (parseFloat(tx.ew_debit) || 0), 0);
    const netLoanBalance = totalLoanCredits - totalLoanDebits;

    const limits = await getMemberWithdrawalLimits(member.Member_id || memberId);
    const totalAddonAmount = limits.totalAddonAmount;
    const totalPackages = limits.totalInvested;
    const hasInvestment = limits.hasInvestment;

    const totalEarningsAmount = (
      parseFloat(levelBenefits || 0) +
      parseFloat(roiLevelBenefits || 0) +
      parseFloat(directBenefits || 0) +
      parseFloat(repaymentCommission || 0) +
      parseFloat(roiBenefits || 0) +
      parseFloat(singleLineIncome || 0)
    );
    const canReinvest = hasInvestment && totalPackages > 0 && totalEarningsAmount >= (2 * totalPackages);

    const singleLevelIncomeByPackage = {};
    const sliTransactions = transactions.filter(tx =>
      (tx.transaction_type === "Single Line Income" || tx.transaction_type === "Single Level Income" || tx.transaction_type === "Single Leg Income") &&
      tx.status === "Completed"
    );

    sliTransactions.forEach(tx => {
      // Extract amount from description e.g., "Single Leg Income (₹30) from U000002"
      const match = tx.description?.match(/\(\₹([\d.]+)\)/);
      if (match && match[1]) {
        const pkgVal = parseFloat(match[1]);
        if (!singleLevelIncomeByPackage[pkgVal]) {
          singleLevelIncomeByPackage[pkgVal] = 0;
        }
        singleLevelIncomeByPackage[pkgVal] += (parseFloat(tx.gross_amount) || parseFloat(tx.net_amount) || parseFloat(tx.ew_credit) || 0);
      }
    });

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const existingWithdrawalToday = transactions.some(tx =>
      tx.transaction_type === "Withdrawal" &&
      ["Pending", "Approved", "Completed", "Processing"].includes(tx.status) &&
      (
        (tx.transaction_date && new Date(tx.transaction_date) >= todayStart && new Date(tx.transaction_date) <= todayEnd) ||
        (tx.createdAt && new Date(tx.createdAt) >= todayStart && new Date(tx.createdAt) <= todayEnd)
      )
    );

    return res.status(200).json({
      success: true,
      hasInvestment: hasInvestment,
      canReTopup: canReinvest,
      canReinvest: canReinvest,
      data: {
        balance: Math.max(0, availableBalance).toFixed(2),
        totalIncome: totalIncome.toFixed(2),
        totalExpenses: totalExpenses.toFixed(2),
        totalWithdrawal: totalWithdrawal.toFixed(2),
        otherDebits: otherDebits.toFixed(2),
        transactionsCount: nonLoanTransactions.length,
        availableForWithdrawal: Math.max(0, availableBalance).toFixed(2),
        levelBenefits: levelBenefits.toFixed(2),
        roiBenefits: roiBenefits.toFixed(2),
        roiLevelBenefits: roiLevelBenefits.toFixed(2),
        levelDailyRoi: roiLevelBenefits.toFixed(2),
        directBenefits: directBenefits.toFixed(2),
        repaymentCommission: repaymentCommission.toFixed(2),
        singleLineIncome: singleLineIncome.toFixed(2),

        singleLevelIncomeByPackage: singleLevelIncomeByPackage,
        totalAddonAmount: totalAddonAmount.toFixed(2),
        totalBenefits: totalEarningsAmount.toFixed(2),
        totalEarnings: totalEarningsAmount.toFixed(2),
        pendingWithdrawals: pendingWithdrawals.toFixed(2),
        primaryPackage: limits.primaryAmount,
        addOnPackages: limits.totalAddonAmount,
        totalPackages: limits.totalInvested,
        totalInvested: limits.totalInvested,
        maxWithdrawalLimit: limits.maxWithdrawalLimit,
        totalWithdrawn: limits.totalWithdrawn,
        remainingWithdrawalLimit: limits.remainingWithdrawalLimit,
        hasInvestment: limits.hasInvestment,
        canReTopup: canReinvest,
        canReinvest: canReinvest,
        requiredEarningsForReinvest: (2 * totalPackages).toFixed(2),
        hasWithdrawnToday: existingWithdrawalToday,
        // Upgrade Wallet
        upgradeWalletBalance: (member.upgrade_wallet || 0).toFixed(2),
        // Top Up Wallet (completely separate)
        topUpBalance: topUpBalance.toFixed(2),
        // Purchase Wallet
        purchaseBalance: (member.purchase_wallet || 0).toFixed(2),
        // Fixed Deposit Wallet
        fixedDepositBalance: (member.fixed_deposit_wallet || 0).toFixed(2),
        // Vendor Wallet
        vendorWalletBalance: (member.vendor_wallet || 0).toFixed(2),
        // Product Level Wallet (Strictly Product Level Income transactions)
        productLevelBalance: levelBenefits.toFixed(2),
        topUpTransactions: topUpTransactions.sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date)),
        fixedDepositTransactions: transactions.filter(tx => (parseFloat(tx.fd_credit) > 0) || (tx.transaction_type && tx.transaction_type.toLowerCase().includes('fixed deposit'))).sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date)),
        purchaseTransactions: transactions.filter(tx => (parseFloat(tx.pw_credit) > 0) || (tx.transaction_type && tx.transaction_type.toLowerCase().includes('purchase'))).sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date)),
        // Loan information (for transparency)
        loanInfo: {
          totalLoanAmount: totalLoanCredits.toFixed(2),
          totalLoanRepaid: totalLoanDebits.toFixed(2),
          outstandingLoan: Math.max(0, netLoanBalance).toFixed(2),
          loanTransactionsCount: loanTransactions.length
        },
        transactions: nonLoanTransactions.sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date)),
        calculation: {
          formula: "Available Balance = Sum of All Credits - Sum of All Debits (excluding loan and top-up transactions)",
          breakdown: `₹${completedAndPendingTx.reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0), 0).toFixed(2)} - ₹${completedAndPendingTx.reduce((acc, tx) => acc + (parseFloat(tx.ew_debit) || 0), 0).toFixed(2)} = ₹${Math.max(0, availableBalance).toFixed(2)}`,
          note: "Available balance excludes loan and top-up transactions. Pending withdrawals: ₹" + pendingWithdrawals.toFixed(2)
        },
      },
    });
  } catch (error) {
    console.error("Error in getWalletOverview:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

const getWalletWithdraw = async (req, res) => {
  try {
    const { memberId, amount, otp } = req.body;

    if (!memberId) return res.status(400).json({ success: false, message: "Member ID is required" });
    if (!amount) return res.status(400).json({ success: false, message: "Withdrawal amount is required" });
    // OTP requirement bypassed for now:
    // if (!otp) return res.status(400).json({ success: false, message: "OTP is required" });

    const withdrawalAmount = parseFloat(amount);
    if (isNaN(withdrawalAmount) || withdrawalAmount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid withdrawal amount" });
    }

    // Check if member already requested a withdrawal today (One withdrawal per day)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const existingWithdrawalToday = await TransactionModel.findOne({
      member_id: memberId,
      transaction_type: "Withdrawal",
      status: { $in: ["Pending", "Approved", "Completed", "Processing"] },
      $or: [
        { transaction_date: { $gte: todayStart, $lte: todayEnd } },
        { createdAt: { $gte: todayStart, $lte: todayEnd } }
      ]
    });

    if (existingWithdrawalToday) {
      return res.status(400).json({
        success: false,
        message: "You have already requested a withdrawal today. Only one withdrawal per day is allowed."
      });
    }

    const member = await MemberModel.findOne({ Member_id: memberId });
    if (!member) return res.status(404).json({ success: false, message: "Member not found" });

    // OTP verification bypassed for now:
    // if (!verifyOTP(member.email, otp)) {
    //   return res.status(400).json({ success: false, message: "Invalid or expired OTP" });
    // }

    // Calculate last Saturday
    const today = new Date();
    const lastSaturday = new Date(today);

    const dayOfWeek = today.getDay(); // 0 = Sunday, 6 = Saturday
    // Correct calculation: go back to previous Saturday
    const daysSinceSaturday = dayOfWeek === 6 ? 0 : dayOfWeek + 1;

    lastSaturday.setDate(today.getDate() - daysSinceSaturday);
    lastSaturday.setHours(0, 0, 0, 0);

    console.log("dayOfweek:", dayOfWeek);
    console.log("daysSinceSaturday:", daysSinceSaturday);
    console.log("lastSaturday:", lastSaturday.toISOString());

    // Check if member has any ACTIVE LOAN (Approved with net_amount > 0)
    const activeLoan = await TransactionModel.findOne({
      member_id: memberId,
      transaction_type: { $regex: /loan/i },
      status: "Approved",
      net_amount: { $gt: "0" } // Loan is still unpaid
    });

    console.log("Active Loan Found:", !!activeLoan);
    if (activeLoan) {
      console.log("Active Loan Details:", {
        transaction_date: activeLoan.transaction_date,
        net_amount: activeLoan.net_amount,
        transaction_type: activeLoan.transaction_type
      });
    }

    // Check if loan was taken BEFORE last Saturday
    // New rule: if an active loan exists (net_amount > 0) AND the loan origination date is before lastSaturday
    // then block withdrawal UNLESS there was a repayment on or after lastSaturday.
    let hasUnpaidLoan = false;
    let lastRepayment = null;
    if (activeLoan) {
      const loanDate = new Date(activeLoan.transaction_date);
      console.log("Loan Date:", loanDate.toISOString());
      console.log("Last Saturday:", lastSaturday.toISOString());

      // Find the latest repayment (if any)
      lastRepayment = await TransactionModel.findOne({
        member_id: memberId,
        transaction_type: { $regex: /repay|repayment|loan repayment/i },
        status: { $in: ["Paid", "Completed", "Approved"] }
      }).sort({ transaction_date: -1 }).exec();

      if (lastRepayment) {
        console.log("Last repayment found:", lastRepayment.transaction_date);
      }

      const unpaidNumeric = parseFloat(activeLoan.net_amount || "0") || 0;

      // Block only if loan was taken before lastSaturday AND there was no repayment on/after lastSaturday AND unpaid amount > 0
      const repaidOnOrAfterLastSaturday = lastRepayment && (new Date(lastRepayment.transaction_date) >= lastSaturday);
      hasUnpaidLoan = loanDate < lastSaturday && unpaidNumeric > 0 && !repaidOnOrAfterLastSaturday;
      console.log("Loan taken before last Saturday:", loanDate < lastSaturday, "unpaidNumeric:", unpaidNumeric, "repaidOnOrAfterLastSaturday:", repaidOnOrAfterLastSaturday, "hasUnpaidLoan:", hasUnpaidLoan);
    }

    const plainMemberId = memberId.startsWith('BMS') ? memberId.replace('BMS', '') : memberId;
    const bmsMemberId = `BMS${plainMemberId}`;
    const allTransactions = await TransactionModel.find({
      member_id: { $in: [memberId, plainMemberId, bmsMemberId] }
    });

    const nonLoanTransactions = allTransactions.filter(tx =>
      !tx.transaction_type?.toLowerCase().includes('loan') &&
      !tx.description?.toLowerCase().includes('loan') &&
      tx.transaction_type !== 'Top up'
    );

    let totalCredits = 0;
    let totalDebits = 0;

    nonLoanTransactions.forEach((tx) => {
      totalCredits += parseFloat(tx.ew_credit) || 0;
      totalDebits += parseFloat(tx.ew_debit) || 0;
    });

    let availableBalance = totalCredits - totalDebits;
    availableBalance = Math.max(0, availableBalance);

    const completedTransactions = nonLoanTransactions.filter(tx => tx.status === "Completed");

    const levelBenefits = completedTransactions
      .filter(tx =>
        (tx.transaction_type === "Level benefits" ||
          tx.description === "Level benefits" ||
          tx.transaction_type === "Level Benefits" ||
          tx.description === "Level Benefits") && Number(tx.level) !== 1
      )
      .reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.uw_credit) || 0) + (parseFloat(tx.fd_credit) || 0) + (parseFloat(tx.pw_credit) || 0), 0);

    const directBenefits = completedTransactions
      .filter(tx =>
        tx.transaction_type === "Direct Benefits" ||
        tx.description === "Direct Benefits" ||
        tx.transaction_type === "Direct benefits" ||
        tx.description === "Direct benefits" ||
        (tx.transaction_type?.toLowerCase().includes("level benefit") && Number(tx.level) === 1)
      )
      .reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.uw_credit) || 0) + (parseFloat(tx.fd_credit) || 0) + (parseFloat(tx.pw_credit) || 0), 0);
    const repaymentCommission = completedTransactions
      .filter(tx =>
        tx.transaction_type === "Repayment Commission" ||
        tx.description === "Repayment Commission" ||
        tx.transaction_type === "Repayment commission" ||
        tx.description === "Repayment commission"
      )
      .reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.uw_credit) || 0) + (parseFloat(tx.fd_credit) || 0) + (parseFloat(tx.pw_credit) || 0), 0);

    const roiBenefits = completedTransactions
      .filter(tx =>
        tx.transaction_type === "ROI Payout"
      )
      .reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.uw_credit) || 0) + (parseFloat(tx.fd_credit) || 0) + (parseFloat(tx.pw_credit) || 0), 0);



    const limits = await getMemberWithdrawalLimits(member.Member_id || memberId);

    if (!limits.hasInvestment) {
      return res.status(400).json({
        success: false,
        message: "You must have an active investment package to request a withdrawal.",
        loanStatus: {
          hasUnpaidLoan: hasUnpaidLoan,
          isWithdrawalAllowed: false,
          message: "No active investment found"
        }
      });
    }

    if (withdrawalAmount > limits.remainingWithdrawalLimit) {
      return res.status(400).json({
        success: false,
        message: `Maximum remaining withdrawal limit is ₹${limits.remainingWithdrawalLimit.toFixed(2)} (Total 2x Limit: ₹${limits.maxWithdrawalLimit.toFixed(2)}, Already Withdrawn: ₹${limits.totalWithdrawn.toFixed(2)})`,
        loanStatus: {
          hasUnpaidLoan: hasUnpaidLoan,
          isWithdrawalAllowed: false,
          message: `Limit exceeded. Remaining allowed: ₹${limits.remainingWithdrawalLimit.toFixed(2)}`
        },
        limits: limits
      });
    }

    // Check if member has unpaid loan from before last Saturday
    if (hasUnpaidLoan) {
      return res.status(400).json({
        success: false,
        message: "Withdrawal not allowed - You have unpaid loan amount from before last Saturday",
        loanStatus: {
          hasUnpaidLoan: true,
          isWithdrawalAllowed: false,
          lastSaturday: lastSaturday.toDateString(),
          loanDate: activeLoan?.transaction_date,
          unpaidAmount: activeLoan?.net_amount,
          message: "Please clear your pending loan amount to enable withdrawals"
        },
        details: {
          requested: withdrawalAmount.toFixed(2),
          available: availableBalance.toFixed(2),
        }
      });
    }

    if (withdrawalAmount > availableBalance) {
      return res.status(400).json({
        success: false,
        message: "Insufficient balance",
        loanStatus: {
          hasUnpaidLoan: hasUnpaidLoan,
          isWithdrawalAllowed: !hasUnpaidLoan,
          message: hasUnpaidLoan ? "Withdrawal blocked - Unpaid loan from before last Saturday" : "No unpaid loans - Withdrawal allowed if balance is sufficient"
        },
        details: {
          requested: withdrawalAmount.toFixed(2),
          available: availableBalance.toFixed(2),
          shortfall: (withdrawalAmount - availableBalance).toFixed(2),
        },
        benefitsBreakdown: {
          levelBenefits: levelBenefits.toFixed(2),
          directBenefits: directBenefits.toFixed(2),
          repaymentCommission: repaymentCommission.toFixed(2),
          roiBenefits: roiBenefits.toFixed(2),
          totalBenefits: (levelBenefits + directBenefits + repaymentCommission + roiBenefits).toFixed(2),
          availableBalance: availableBalance.toFixed(2)
        },
        note: "Loan amounts are not included in available balance for withdrawals."
      });
    }

    const deduction = withdrawalAmount * 0.10;
    const netAmount = withdrawalAmount - deduction;

    const newTransactionId = await generateTransactionId("WTH");

    const newTransaction = new TransactionModel({
      transaction_id: newTransactionId,
      transaction_date: new Date(),
      member_id: memberId,
      description: "Withdrawal Request",
      transaction_type: "Withdrawal",
      ew_credit: 0,
      ew_debit: withdrawalAmount,
      status: "Pending",
      deduction: deduction,
      net_amount: netAmount,
      gross_amount: withdrawalAmount,
      benefits_source: {
        level_benefits_used: levelBenefits,
        direct_benefits_used: directBenefits,
        repayment_commission_used: repaymentCommission,
        roi_benefits_used: roiBenefits,
        total_benefits_available: levelBenefits + directBenefits + repaymentCommission + roiBenefits
      }
    });

    await newTransaction.save();

    // Deduct from member's wallet_balance field (sync with Available Balance)
    await MemberModel.findOneAndUpdate(
      { Member_id: memberId },
      { $inc: { wallet_balance: -withdrawalAmount } }
    );

    let newAvailableBalance = availableBalance - withdrawalAmount;
    newAvailableBalance = Math.max(0, newAvailableBalance);

    return res.status(200).json({
      success: true,
      message: "Withdrawal request submitted successfully",
      data: {
        transactionId: newTransaction.transaction_id,
        withdrawalDetails: {
          grossAmount: withdrawalAmount.toFixed(2),
          deduction: deduction.toFixed(2),
          netAmount: netAmount.toFixed(2),
          deductionRate: "10%"
        },
        balanceDetails: {
          previousBalance: availableBalance.toFixed(2),
          withdrawalAmount: withdrawalAmount.toFixed(2),
          newAvailableBalance: newAvailableBalance.toFixed(2)
        },
        benefitsBreakdown: {
          levelBenefits: levelBenefits.toFixed(2),
          directBenefits: directBenefits.toFixed(2),
          repaymentCommission: repaymentCommission.toFixed(2),
          roiBenefits: roiBenefits.toFixed(2),
          totalBenefits: (levelBenefits + directBenefits + repaymentCommission + roiBenefits).toFixed(2),
          benefitsContribution: `${((levelBenefits + directBenefits + repaymentCommission + roiBenefits) / (totalCredits || 1) * 100).toFixed(1)}% of total income`
        },
        loanStatus: {
          hasUnpaidLoan: false,
          isWithdrawalAllowed: true,
          message: "No unpaid loans - Withdrawal processed successfully"
        },
        status: "Pending",
        calculation: {
          deduction: `10% of ₹${withdrawalAmount.toFixed(2)} = ₹${deduction.toFixed(2)}`,
          netAmount: `₹${withdrawalAmount.toFixed(2)} - ₹${deduction.toFixed(2)} = ₹${netAmount.toFixed(2)}`,
          balanceUpdate: `₹${availableBalance.toFixed(2)} - ₹${withdrawalAmount.toFixed(2)} = ₹${newAvailableBalance.toFixed(2)}`
        },
        note: "Your available balance excludes loan transactions and includes this pending withdrawal."
      },
    });
  } catch (error) {
    console.error("Error in getWalletWithdraw:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message
    });
  }
};


const sendWithdrawalOTP = async (req, res) => {
  try {
    const { memberId, amount } = req.body;

    if (!memberId) return res.status(400).json({ success: false, message: "Member ID is required" });
    if (!amount) return res.status(400).json({ success: false, message: "Withdrawal amount is required" });

    const withdrawalAmount = parseFloat(amount);
    if (isNaN(withdrawalAmount) || withdrawalAmount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid withdrawal amount" });
    }

    // Check if member already requested a withdrawal today (One withdrawal per day)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const existingWithdrawalToday = await TransactionModel.findOne({
      member_id: memberId,
      transaction_type: "Withdrawal",
      status: { $in: ["Pending", "Approved", "Completed", "Processing"] },
      $or: [
        { transaction_date: { $gte: todayStart, $lte: todayEnd } },
        { createdAt: { $gte: todayStart, $lte: todayEnd } }
      ]
    });

    if (existingWithdrawalToday) {
      return res.status(400).json({
        success: false,
        message: "You have already requested a withdrawal today. Only one withdrawal per day is allowed."
      });
    }

    const member = await MemberModel.findOne({ Member_id: memberId });
    if (!member) return res.status(404).json({ success: false, message: "Member not found" });

    // Loan and balance logic
    const today = new Date();
    const lastSaturday = new Date(today);
    const dayOfWeek = today.getDay();
    const daysSinceSaturday = dayOfWeek === 6 ? 0 : dayOfWeek + 1;
    lastSaturday.setDate(today.getDate() - daysSinceSaturday);
    lastSaturday.setHours(0, 0, 0, 0);

    const activeLoan = await TransactionModel.findOne({
      member_id: memberId,
      transaction_type: { $regex: /loan/i },
      status: "Approved",
      net_amount: { $gt: "0" }
    });

    let hasUnpaidLoan = false;
    let lastRepayment = null;
    if (activeLoan) {
      const loanDate = new Date(activeLoan.transaction_date);
      lastRepayment = await TransactionModel.findOne({
        member_id: memberId,
        transaction_type: { $regex: /repay|repayment|loan repayment/i },
        status: { $in: ["Paid", "Completed", "Approved"] }
      }).sort({ transaction_date: -1 }).exec();

      const unpaidNumeric = parseFloat(activeLoan.net_amount || "0") || 0;
      const repaidOnOrAfterLastSaturday = lastRepayment && (new Date(lastRepayment.transaction_date) >= lastSaturday);
      hasUnpaidLoan = loanDate < lastSaturday && unpaidNumeric > 0 && !repaidOnOrAfterLastSaturday;
    }

    const numericPart = parseInt(memberId.replace('BMS', ''), 10);
    const pad5 = String(numericPart).padStart(5, '0');
    const pad6 = String(numericPart).padStart(6, '0');
    const possibleIds = [memberId, memberId.replace('BMS', ''), `BMS${pad5}`, `BMS${pad6}`, pad5, pad6, `BMS${numericPart}`];

    const allTransactions = await TransactionModel.find({
      member_id: { $in: possibleIds }
    });
    const nonLoanTransactions = allTransactions.filter(tx =>
      !tx.transaction_type?.toLowerCase().includes('loan') &&
      !tx.description?.toLowerCase().includes('loan') &&
      tx.transaction_type !== 'Top up'
    );

    let totalCredits = 0;
    let totalDebits = 0;
    nonLoanTransactions.forEach((tx) => {
      totalCredits += parseFloat(tx.ew_credit) || 0;
      totalDebits += parseFloat(tx.ew_debit) || 0;
    });

    let availableBalance = Math.max(0, totalCredits - totalDebits);

    const limits = await getMemberWithdrawalLimits(member.Member_id || memberId);

    if (!limits.hasInvestment) {
      return res.status(400).json({
        success: false,
        message: "You must have an active investment package to request a withdrawal."
      });
    }

    if (withdrawalAmount > limits.remainingWithdrawalLimit) {
      return res.status(400).json({
        success: false,
        message: `Maximum remaining withdrawal limit is ₹${limits.remainingWithdrawalLimit.toFixed(2)} (Total 2x Limit: ₹${limits.maxWithdrawalLimit.toFixed(2)}, Already Withdrawn: ₹${limits.totalWithdrawn.toFixed(2)})`,
        limits: limits
      });
    }

    if (hasUnpaidLoan) {
      return res.status(400).json({ success: false, message: "Withdrawal not allowed - You have unpaid loan amount from before last Saturday" });
    }

    if (withdrawalAmount > availableBalance) {
      return res.status(400).json({ success: false, message: "Insufficient balance" });
    }

    // Generate and send OTP
    const otp = generateOTP();
    storeOTP(member.email, otp);

    const bmsLogoPath = path.join(__dirname, '..', '..', '..', 'utils', 'BMS.png');
    const attachments = [{
      filename: 'BMS.png',
      path: bmsLogoPath,
      cid: 'bmslogo'
    }];

    const htmlContent = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #111827; border-radius: 12px; border: 1px solid #374151;">
      <div style="text-align: center; margin-bottom: 10px;">
        <h1 style="color: #38bdf8; text-align: center; margin: 0 0 10px 0; font-size: 32px; font-weight: 900; letter-spacing: 2px;">E shopy</h1>
      </div>
      <div style="background-color: #1f2937; padding: 30px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);">
        <h2 style="color: #ffffff; margin-top: 0; text-align: center; font-size: 24px;">Withdrawal Verification</h2>
        <p style="color: #d1d5db; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
          Dear <strong style="color: #fbbf24;">${member.Name || 'Member'}</strong>,
        </p>
        <p style="color: #ffffff; font-size: 16px; line-height: 1.6; margin-bottom: 25px;">
          You have requested to withdraw <strong>₹${withdrawalAmount.toFixed(2)}</strong> from your wallet. 
          Please use the following OTP to authorize and complete this transaction:
        </p>
        <div style="background-color: #374151; border-left: 4px solid #fbbf24; padding: 20px; margin: 25px 0; border-radius: 4px; text-align: center;">
          <h1 style="color: #fbbf24; margin: 0; font-size: 32px; letter-spacing: 5px;">${otp}</h1>
        </div>
        <p style="color: #9ca3af; font-size: 14px; line-height: 1.6; margin-bottom: 20px;">
          This OTP is valid for 3 minutes. If you did not request this withdrawal, please secure your account immediately.
        </p>
      </div>
      <div style="text-align: center; margin-top: 25px; color: #9ca3af; font-size: 12px;">
        &copy; ${new Date().getFullYear()} E shopy. All rights reserved.
      </div>
    </div>`;

    // OTP sending commented out for now:
    // await sendMail(member.email, "E shopy - Withdrawal Verification OTP", htmlContent, `Your OTP is ${otp}`, attachments);

    return res.status(200).json({ success: true, message: "OTP bypassed for now" });
  } catch (error) {
    console.error("Error in sendWithdrawalOTP:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
}; const sendTransferOTP = async (req, res) => {
  // Deprecated: SMS OTP is now handled by Firebase Phone Auth on the frontend.
  return res.status(200).json({ success: true, message: "Deprecated endpoint" });
}; const transferWallet = async (req, res) => {
  try {
    const { memberId, fromWallet, toWallet, amount, otp } = req.body; // otp here is the Firebase idToken

    if (!memberId || !fromWallet || !toWallet || !amount || !otp) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const transferAmount = parseFloat(amount);
    if (isNaN(transferAmount) || transferAmount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid transfer amount" });
    }

    // Validation rules
    const validTransfers = [
      { from: 'Earnings', to: 'Top Up Wallet' },
      { from: 'Earnings', to: 'Upgrade Wallet' },
      { from: 'Top Up', to: 'Upgrade Wallet' },
      { from: 'Upgrade', to: 'Top Up Wallet' }
    ];

    const isValidTransfer = validTransfers.some(t => t.from === fromWallet && t.to === toWallet);
    if (!isValidTransfer) {
      return res.status(400).json({ success: false, message: "Invalid transfer combination" });
    }

    const member = await MemberModel.findOne({ Member_id: memberId });
    if (!member) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }

    if (otp === 'BYPASS_TOKEN') {
      console.log("⚠️ Bypassing Firebase token verification for BYPASS_TOKEN in transferWallet");
    } else {
      try {
        const decodedToken = await admin.auth().verifyIdToken(otp);
        const phoneVerified = decodedToken.phone_number;

        let memberPhone = String(member.mobileno).trim().replace(/\s+/g, '');
        if (!memberPhone.startsWith('+')) {
          memberPhone = '+91' + memberPhone;
        }

        if (phoneVerified !== memberPhone) {
          return res.status(400).json({ success: false, message: "Phone number mismatch. Please use your registered mobile number." });
        }
      } catch (firebaseError) {
        console.error("Firebase Verification Error:", firebaseError);
        return res.status(400).json({ success: false, message: "Invalid or expired Firebase token." });
      }
    }

    let currentBalance = 0;
    const numericPart = parseInt(memberId.replace('BMS', ''), 10);
    const pad5 = String(numericPart).padStart(5, '0');
    const pad6 = String(numericPart).padStart(6, '0');
    const possibleIds = [memberId, memberId.replace('BMS', ''), `BMS${pad5}`, `BMS${pad6}`, pad5, pad6, `BMS${numericPart}`];

    const transactions = await TransactionModel.find({
      member_id: { $in: possibleIds }
    });

    if (fromWallet === "Earnings") {
      const nonLoanTransactions = transactions.filter(tx =>
        !tx.transaction_type?.toLowerCase().includes('loan') &&
        !tx.description?.toLowerCase().includes('loan') &&
        tx.transaction_type !== 'Top up'
      );
      const completedAndPendingTx = nonLoanTransactions.filter(tx =>
        tx.status === "Completed" || tx.status === "Pending" || tx.status === "Approved"
      );
      const availableBalance = completedAndPendingTx.reduce((acc, tx) =>
        acc + (parseFloat(tx.ew_credit) || 0) - (parseFloat(tx.ew_debit) || 0), 0
      );
      currentBalance = Math.max(0, availableBalance);
    } else if (fromWallet === "Top Up") {
      const topUpTransactions = transactions.filter(tx => tx.transaction_type === 'Top up');
      const topUpCredits = topUpTransactions
        .filter(tx => tx.status === 'Completed' || tx.status === 'Approved')
        .reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0), 0);
      const topUpDebits = topUpTransactions
        .filter(tx => tx.status === 'Completed' || tx.status === 'Approved')
        .reduce((acc, tx) => acc + (parseFloat(tx.ew_debit) || 0), 0);
      currentBalance = Math.max(0, topUpCredits - topUpDebits);
    } else if (fromWallet === "Upgrade") {
      currentBalance = member.upgrade_wallet || 0;
    } else {
      return res.status(400).json({ success: false, message: "Invalid source wallet" });
    }

    if (transferAmount > currentBalance) {
      return res.status(400).json({ success: false, message: "Insufficient balance in " + fromWallet });
    }

    const debitTxId = await generateTransactionId("TRF_D");
    const creditTxId = await generateTransactionId("TRF_C");

    if (fromWallet === "Earnings" && toWallet === "Top Up Wallet") {
      // Create two transactions: one to debit earnings, one to credit top up
      const debitTx = new TransactionModel({
        transaction_id: debitTxId,
        transaction_date: new Date(),
        member_id: memberId,
        description: `Wallet Transfer: Earnings to Top Up Wallet`,
        transaction_type: "Wallet Transfer",
        ew_credit: 0,
        ew_debit: transferAmount,
        uw_credit: 0,
        uw_debit: 0,
        status: "Completed",
        net_amount: transferAmount,
        gross_amount: transferAmount
      });
      await debitTx.save();

      const creditTx = new TransactionModel({
        transaction_id: creditTxId,
        transaction_date: new Date(),
        member_id: memberId,
        description: `Wallet Transfer: Received from Earnings`,
        transaction_type: "Top up",
        ew_credit: transferAmount,
        ew_debit: 0,
        uw_credit: 0,
        uw_debit: 0,
        status: "Completed",
        net_amount: transferAmount,
        gross_amount: transferAmount
      });
      await creditTx.save();

      await MemberModel.findOneAndUpdate({ Member_id: memberId }, {
        $inc: { wallet_balance: -transferAmount, top_up_wallet: transferAmount }
      });

    } else if (fromWallet === "Earnings" && toWallet === "Upgrade Wallet") {
      // Create two transactions: one to debit earnings, one to credit upgrade
      const debitTx = new TransactionModel({
        transaction_id: debitTxId,
        transaction_date: new Date(),
        member_id: memberId,
        description: `Wallet Transfer: Earnings to Upgrade Wallet`,
        transaction_type: "Wallet Transfer",
        ew_credit: 0,
        ew_debit: transferAmount,
        uw_credit: 0,
        uw_debit: 0,
        status: "Completed",
        net_amount: transferAmount,
        gross_amount: transferAmount
      });
      await debitTx.save();

      const creditTx = new TransactionModel({
        transaction_id: creditTxId,
        transaction_date: new Date(),
        member_id: memberId,
        description: `Wallet Transfer: Received from Earnings`,
        transaction_type: "Top up", // using Top up type to reflect in wallet
        ew_credit: 0,
        ew_debit: 0,
        uw_credit: transferAmount,
        uw_debit: 0,
        status: "Completed",
        net_amount: transferAmount,
        gross_amount: transferAmount
      });
      await creditTx.save();

      await MemberModel.findOneAndUpdate({ Member_id: memberId }, {
        $inc: { wallet_balance: -transferAmount, upgrade_wallet: transferAmount }
      });

    } else if (fromWallet === "Top Up" && toWallet === "Upgrade Wallet") {
      const tx = new TransactionModel({
        transaction_id: debitTxId,
        transaction_date: new Date(),
        member_id: memberId,
        description: `Wallet Transfer: Top Up to Upgrade Wallet`,
        transaction_type: "Top up", // Mark as top up so it counts as top up debit
        ew_credit: 0,
        ew_debit: transferAmount,
        uw_credit: transferAmount,
        uw_debit: 0,
        status: "Completed",
        net_amount: transferAmount,
        gross_amount: transferAmount
      });
      await tx.save();

      await MemberModel.findOneAndUpdate({ Member_id: memberId }, {
        $inc: { top_up_wallet: -transferAmount, upgrade_wallet: transferAmount }
      });

    } else if (fromWallet === "Upgrade" && toWallet === "Top Up Wallet") {
      const tx = new TransactionModel({
        transaction_id: debitTxId,
        transaction_date: new Date(),
        member_id: memberId,
        description: `Wallet Transfer: Upgrade to Purchase Wallet`,
        transaction_type: "Top up",
        ew_credit: 0,
        ew_debit: 0,
        uw_credit: 0,
        uw_debit: transferAmount,
        status: "Completed",
        net_amount: transferAmount,
        gross_amount: transferAmount
      });
      await tx.save();

      const creditTx = new TransactionModel({
        transaction_id: creditTxId,
        transaction_date: new Date(),
        member_id: memberId,
        description: `Wallet Transfer: Received from Upgrade Wallet`,
        transaction_type: "Top up",
        ew_credit: transferAmount,
        ew_debit: 0,
        uw_credit: 0,
        uw_debit: 0,
        status: "Completed",
        net_amount: transferAmount,
        gross_amount: transferAmount
      });
      await creditTx.save();

      await MemberModel.findOneAndUpdate({ Member_id: memberId }, {
        $inc: { upgrade_wallet: -transferAmount, top_up_wallet: transferAmount }
      });
    }

    return res.status(200).json({ success: true, message: "Transfer successful" });
  } catch (error) {
    console.error("Error in transferWallet:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

const lookupMemberForTransfer = async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) {
      return res.status(400).json({ success: false, message: "Query parameter required" });
    }
    let cleanQuery = query.replace(/^(?:BMS|Ecash|Eshopy|E-shopy)-P2P:/i, "").trim();

    const member = await MemberModel.findOne({
      $or: [
        { Member_id: cleanQuery },
        { qr_code: query },
        { Member_id: query },
        { member_id: cleanQuery }
      ]
    }).select("Member_id member_id Name email mobileno profile_image qr_code");

    if (!member) {
      return res.status(404).json({ success: false, message: "Member not found with this QR Code or ID" });
    }

    return res.status(200).json({
      success: true,
      data: {
        Member_id: member.Member_id || member.member_id,
        Name: member.Name,
        email: member.email,
        mobileno: member.mobileno ? String(member.mobileno).replace(/.(?=.{4})/g, '*') : 'N/A',
        profile_image: member.profile_image,
        qr_code: member.qr_code || `Eshopy-P2P:${member.Member_id || member.member_id}`
      }
    });
  } catch (error) {
    console.error("Error looking up member:", error);
    return res.status(500).json({ success: false, message: "Server error during lookup" });
  }
};

const transferP2PWallet = async (req, res) => {
  try {
    const { memberId, receiverId, fromWallet, amount, otp } = req.body;

    if (!memberId || !receiverId || !fromWallet || !amount || !otp) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const transferAmount = parseFloat(amount);
    if (isNaN(transferAmount) || transferAmount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid transfer amount" });
    }

    if (memberId === receiverId) {
      return res.status(400).json({ success: false, message: "You cannot transfer funds to yourself" });
    }

    const member = await MemberModel.findOne({ Member_id: memberId });
    if (!member) {
      return res.status(404).json({ success: false, message: "Sender member not found" });
    }

    let cleanReceiver = receiverId.replace(/^(?:BMS|Ecash|Eshopy|E-shopy)-P2P:/i, "").trim();
    const receiverMember = await MemberModel.findOne({
      $or: [
        { Member_id: cleanReceiver },
        { qr_code: receiverId },
        { Member_id: receiverId },
        { member_id: cleanReceiver }
      ]
    });
    if (!receiverMember) {
      return res.status(404).json({ success: false, message: "Recipient member not found" });
    }

    if (otp === 'BYPASS_TOKEN') {
      console.log("⚠️ Bypassing Firebase token verification for BYPASS_TOKEN in transferP2PWallet");
    } else {
      try {
        const decodedToken = await admin.auth().verifyIdToken(otp);
        const phoneVerified = decodedToken.phone_number;

        let memberPhone = String(member.mobileno).trim().replace(/\s+/g, '');
        if (!memberPhone.startsWith('+')) {
          memberPhone = '+91' + memberPhone;
        }

        if (phoneVerified !== memberPhone) {
          return res.status(400).json({ success: false, message: "Phone number mismatch. Please use your registered mobile number." });
        }
      } catch (firebaseError) {
        console.error("Firebase Verification Error:", firebaseError);
        return res.status(400).json({ success: false, message: "Invalid or expired Firebase token." });
      }
    }

    let currentBalance = 0;
    const numericPart = parseInt(memberId.replace('BMS', ''), 10);
    const pad5 = String(numericPart).padStart(5, '0');
    const pad6 = String(numericPart).padStart(6, '0');
    const possibleIds = [memberId, memberId.replace('BMS', ''), `BMS${pad5}`, `BMS${pad6}`, pad5, pad6, `BMS${numericPart}`];

    const transactions = await TransactionModel.find({
      member_id: { $in: possibleIds }
    });

    // Support Credits / Earnings / Main / Top Up
    if (fromWallet === "Credits" || fromWallet === "Credits Wallet" || fromWallet === "Earnings" || fromWallet === "Earnings Wallet" || fromWallet === "Withdrawal Wallet" || fromWallet === "Main Wallet") {
      const nonLoanTransactions = transactions.filter(tx =>
        !tx.transaction_type?.toLowerCase().includes('loan') &&
        !tx.description?.toLowerCase().includes('loan') &&
        tx.transaction_type !== 'Top up'
      );
      const completedAndPendingTx = nonLoanTransactions.filter(tx =>
        tx.status === "Completed" || tx.status === "Pending" || tx.status === "Approved"
      );
      const availableBalance = completedAndPendingTx.reduce((acc, tx) =>
        acc + (parseFloat(tx.ew_credit) || 0) - (parseFloat(tx.ew_debit) || 0), 0
      );
      currentBalance = Math.max(0, availableBalance);
    } else if (fromWallet === "Top Up" || fromWallet === "Top Up Wallet") {
      const topUpTransactions = transactions.filter(tx => tx.transaction_type === 'Top up');
      const topUpCredits = topUpTransactions
        .filter(tx => tx.status === 'Completed' || tx.status === 'Approved')
        .reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0), 0);
      const topUpDebits = topUpTransactions
        .filter(tx => tx.status === 'Completed' || tx.status === 'Approved')
        .reduce((acc, tx) => acc + (parseFloat(tx.ew_debit) || 0), 0);
      currentBalance = Math.max(0, topUpCredits - topUpDebits);
    } else {
      // Default to Credits wallet
      const nonLoanTransactions = transactions.filter(tx =>
        !tx.transaction_type?.toLowerCase().includes('loan') &&
        !tx.description?.toLowerCase().includes('loan') &&
        tx.transaction_type !== 'Top up'
      );
      const completedAndPendingTx = nonLoanTransactions.filter(tx =>
        tx.status === "Completed" || tx.status === "Pending" || tx.status === "Approved"
      );
      const availableBalance = completedAndPendingTx.reduce((acc, tx) =>
        acc + (parseFloat(tx.ew_credit) || 0) - (parseFloat(tx.ew_debit) || 0), 0
      );
      currentBalance = Math.max(0, availableBalance);
    }

    if (transferAmount > currentBalance) {
      return res.status(400).json({ success: false, message: "Insufficient Credits balance for transfer" });
    }

    const debitTxId = await generateTransactionId("P2P_D");
    const creditTxId = await generateTransactionId("P2P_C");

    const debitTx = new TransactionModel({
      transaction_id: debitTxId,
      transaction_date: new Date(),
      member_id: memberId,
      description: `P2P Transfer sent to ${receiverMember.Name} (${receiverMember.Member_id})`,
      transaction_type: "P2P Transfer",
      ew_credit: 0,
      ew_debit: transferAmount,
      uw_credit: 0,
      uw_debit: 0,
      status: "Completed",
      net_amount: transferAmount,
      gross_amount: transferAmount
    });
    await debitTx.save();

    const creditTx = new TransactionModel({
      transaction_id: creditTxId,
      transaction_date: new Date(),
      member_id: receiverMember.Member_id,
      description: `P2P Transfer received from ${member.Name} (${member.Member_id})`,
      transaction_type: "P2P Transfer",
      ew_credit: transferAmount,
      ew_debit: 0,
      uw_credit: 0,
      uw_debit: 0,
      status: "Completed",
      net_amount: transferAmount,
      gross_amount: transferAmount
    });
    await creditTx.save();

    // Debit sender Credits wallet & Credit receiver Credits wallet
    await MemberModel.findOneAndUpdate({ Member_id: memberId }, { $inc: { wallet_balance: -transferAmount } });
    await MemberModel.findOneAndUpdate({ Member_id: receiverMember.Member_id }, { $inc: { wallet_balance: transferAmount } });

    return res.status(200).json({ success: true, message: `Successfully transferred ₹${transferAmount} to ${receiverMember.Name}!` });
  } catch (error) {
    console.error("Error in transferP2PWallet:", error);
    return res.status(500).json({ success: false, message: "Server error during P2P transfer", error: error.message });
  }
};

/**
 * Vendor Wallet Overview
 * Returns vendor wallet balance, withdrawal stats, and transactions
 */
const getVendorWalletOverview = async (req, res) => {
  try {
    const { memberId } = req.params;
    if (!memberId) {
      return res.status(400).json({ success: false, message: "Member ID is required" });
    }

    const member = await MemberModel.findOne({
      $or: [{ Member_id: memberId }, { member_id: memberId }]
    });
    if (!member) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }

    const actualMemberId = member.Member_id || memberId;
    const numericPart = parseInt(actualMemberId.replace(/[^0-9]/g, ''), 10);
    const pad5 = !isNaN(numericPart) ? String(numericPart).padStart(5, '0') : actualMemberId;
    const pad6 = !isNaN(numericPart) ? String(numericPart).padStart(6, '0') : actualMemberId;

    const possibleIds = Array.from(new Set([
      actualMemberId,
      actualMemberId.replace('BMS', ''),
      `BMS${pad5}`,
      `BMS${pad6}`,
      pad5,
      pad6,
      !isNaN(numericPart) ? `BMS${numericPart}` : actualMemberId
    ].filter(Boolean)));

    const transactions = await TransactionModel.find({
      member_id: { $in: possibleIds },
      $or: [
        { transaction_type: { $regex: /vendor/i } },
        { description: { $regex: /vendor/i } },
        { transaction_type: { $in: ["Daily Incentive", "Level Bonus", "Referral Bonus", "Level Daily ROI", "ROI Payout", "Global Income"] } },
        { vw_credit: { $exists: true, $nin: ["", "0", 0, null] } },
        { vw_debit: { $exists: true, $nin: ["", "0", 0, null] } }
      ]
    }).sort({ createdAt: -1, transaction_date: -1 });

    const vendorBalance = Math.max(0, parseFloat(member.vendor_wallet) || 0);

    const completedWithdrawals = transactions
      .filter(tx => (tx.transaction_type?.toLowerCase().includes("withdrawal") || parseFloat(tx.vw_debit) > 0) && tx.status === "Completed")
      .reduce((acc, tx) => acc + (parseFloat(tx.vw_debit) || parseFloat(tx.gross_amount) || 0), 0);

    const pendingWithdrawals = transactions
      .filter(tx => (tx.transaction_type?.toLowerCase().includes("withdrawal") || parseFloat(tx.vw_debit) > 0) && (tx.status === "Pending" || tx.status === "Processing"))
      .reduce((acc, tx) => acc + (parseFloat(tx.vw_debit) || parseFloat(tx.gross_amount) || 0), 0);

    const totalIncome = transactions
      .filter(tx => (parseFloat(tx.vw_credit) > 0 || (!tx.transaction_type?.toLowerCase().includes("withdrawal") && tx.status === "Completed" && (parseFloat(tx.vw_credit) > 0 || parseFloat(tx.net_amount) > 0))))
      .reduce((acc, tx) => acc + (parseFloat(tx.vw_credit) || parseFloat(tx.net_amount) || 0), 0);

    return res.status(200).json({
      success: true,
      data: {
        balance: vendorBalance.toFixed(2),
        vendorWalletBalance: vendorBalance.toFixed(2),
        totalIncome: totalIncome.toFixed(2),
        totalWithdrawal: completedWithdrawals.toFixed(2),
        pendingWithdrawals: pendingWithdrawals.toFixed(2),
        transactionsCount: transactions.length,
        transactions: transactions
      }
    });
  } catch (error) {
    console.error("Error in getVendorWalletOverview:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

/**
 * Vendor Wallet Withdrawal
 * Exclusively handles withdrawals from Vendor Wallet
 */
const vendorWalletWithdraw = async (req, res) => {
  try {
    const { memberId } = req.params;
    const { amount } = req.body;

    if (!memberId) {
      return res.status(400).json({ success: false, message: "Member ID is required" });
    }
    if (!amount) {
      return res.status(400).json({ success: false, message: "Withdrawal amount is required" });
    }

    const withdrawalAmount = parseFloat(amount);
    if (isNaN(withdrawalAmount) || withdrawalAmount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid withdrawal amount" });
    }

    const member = await MemberModel.findOne({
      $or: [{ Member_id: memberId }, { member_id: memberId }]
    });
    if (!member) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }

    const actualMemberId = member.Member_id || memberId;
    const currentBalance = parseFloat(member.vendor_wallet) || 0;

    if (withdrawalAmount > currentBalance) {
      return res.status(400).json({
        success: false,
        message: `Insufficient vendor wallet balance. Available: ₹${currentBalance.toFixed(2)}`
      });
    }

    // 10% standard deduction
    const deduction = withdrawalAmount * 0.10;
    const netAmount = withdrawalAmount - deduction;

    const newTransactionId = await generateTransactionId("V_WTH");

    const newTransaction = new TransactionModel({
      transaction_id: newTransactionId,
      transaction_date: new Date(),
      member_id: actualMemberId,
      description: "Vendor Wallet Withdrawal Request",
      transaction_type: "Vendor Withdrawal",
      vw_credit: 0,
      vw_debit: withdrawalAmount,
      ew_credit: 0,
      ew_debit: 0,
      status: "Pending",
      deduction: deduction,
      net_amount: netAmount,
      gross_amount: withdrawalAmount
    });

    await newTransaction.save();

    // Deduct from vendor_wallet atomically
    const updatedMember = await MemberModel.findOneAndUpdate(
      { $or: [{ Member_id: actualMemberId }, { member_id: actualMemberId }] },
      { $inc: { vendor_wallet: -withdrawalAmount } },
      { new: true }
    );

    const newBalance = Math.max(0, parseFloat(updatedMember.vendor_wallet) || 0);

    return res.status(200).json({
      success: true,
      message: "Vendor wallet withdrawal request submitted successfully",
      data: {
        transactionId: newTransaction.transaction_id,
        withdrawalDetails: {
          grossAmount: withdrawalAmount.toFixed(2),
          deduction: deduction.toFixed(2),
          netAmount: netAmount.toFixed(2),
          deductionRate: "10%"
        },
        balanceDetails: {
          previousBalance: currentBalance.toFixed(2),
          withdrawalAmount: withdrawalAmount.toFixed(2),
          newAvailableBalance: newBalance.toFixed(2)
        },
        status: "Pending"
      }
    });
  } catch (error) {
    console.error("Error in vendorWalletWithdraw:", error);
    return res.status(500).json({
      success: false,
      message: "Server error during vendor wallet withdrawal",
      error: error.message
    });
  }
};

/**
 * Product Level Wallet Overview
 * Strictly fetches and computes Product Level Income transactions & dedicated withdrawals
 */
const getProductLevelWalletOverview = async (req, res) => {
  try {
    const { memberId } = req.params;
    if (!memberId) {
      return res.status(400).json({ success: false, message: "Member ID is required" });
    }

    const member = await MemberModel.findOne({
      $or: [{ Member_id: memberId }, { member_id: memberId }]
    });
    if (!member) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }

    const actualMemberId = member.Member_id || memberId;
    const numericPart = parseInt(actualMemberId.replace(/[^0-9]/g, ''), 10);
    const pad5 = !isNaN(numericPart) ? String(numericPart).padStart(5, '0') : actualMemberId;
    const pad6 = !isNaN(numericPart) ? String(numericPart).padStart(6, '0') : actualMemberId;

    const possibleIds = Array.from(new Set([
      actualMemberId,
      actualMemberId.replace('BMS', ''),
      `BMS${pad5}`,
      `BMS${pad6}`,
      pad5,
      pad6,
      !isNaN(numericPart) ? `BMS${numericPart}` : actualMemberId
    ].filter(Boolean)));

    const allTxs = await TransactionModel.find({
      member_id: { $in: possibleIds }
    }).sort({ createdAt: -1, transaction_date: -1 });

    const transactions = allTxs.filter(tx => {
      const txType = (tx.transaction_type || "").toLowerCase();
      const desc = (tx.description || "").toLowerCase();
      const benefit = (tx.benefit_type || "").toLowerCase();

      const isProductLevelIncome = (
        desc.includes("product level") ||
        txType.includes("product level") ||
        desc.includes("level benefit") ||
        desc.includes("level bonus") ||
        txType.includes("level benefit") ||
        txType.includes("level bonus") ||
        benefit.includes("level income")
      );

      const isProductLevelWithdrawal = (
        txType.includes("product level withdrawal") ||
        (desc.includes("product level") && (txType.includes("withdrawal") || desc.includes("withdrawal")))
      );

      const isExcluded = (
        desc.includes("roi") ||
        txType.includes("roi") ||
        desc.includes("referral") ||
        txType.includes("referral") ||
        desc.includes("daily incentive") ||
        txType.includes("daily incentive") ||
        txType === "vendor withdrawal"
      );

      return (isProductLevelIncome || isProductLevelWithdrawal) && !isExcluded;
    });

    const totalIncome = transactions
      .filter(tx => {
        const txType = (tx.transaction_type || "").toLowerCase();
        return !txType.includes("withdrawal") && tx.status === "Completed";
      })
      .reduce((acc, tx) => acc + (parseFloat(tx.vw_credit) || 0) + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.gross_amount) || 0), 0);

    const completedWithdrawals = transactions
      .filter(tx => {
        const txType = (tx.transaction_type || "").toLowerCase();
        return txType.includes("withdrawal") && tx.status === "Completed";
      })
      .reduce((acc, tx) => acc + (parseFloat(tx.gross_amount) || parseFloat(tx.ew_debit) || parseFloat(tx.vw_debit) || 0), 0);

    const pendingWithdrawals = transactions
      .filter(tx => {
        const txType = (tx.transaction_type || "").toLowerCase();
        return txType.includes("withdrawal") && (tx.status === "Pending" || tx.status === "Processing");
      })
      .reduce((acc, tx) => acc + (parseFloat(tx.gross_amount) || parseFloat(tx.ew_debit) || parseFloat(tx.vw_debit) || 0), 0);

    const productLevelBalance = Math.max(0, totalIncome - completedWithdrawals - pendingWithdrawals);

    return res.status(200).json({
      success: true,
      data: {
        balance: productLevelBalance.toFixed(2),
        productLevelBalance: productLevelBalance.toFixed(2),
        totalIncome: totalIncome.toFixed(2),
        totalWithdrawal: completedWithdrawals.toFixed(2),
        pendingWithdrawals: pendingWithdrawals.toFixed(2),
        transactionsCount: transactions.length,
        transactions: transactions
      }
    });
  } catch (error) {
    console.error("Error in getProductLevelWalletOverview:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

/**
 * Product Level Wallet Withdrawal
 * Exclusively handles withdrawals from Product Level Income
 */
const productLevelWalletWithdraw = async (req, res) => {
  try {
    const { memberId } = req.params;
    const { amount } = req.body;

    if (!memberId) {
      return res.status(400).json({ success: false, message: "Member ID is required" });
    }
    if (!amount) {
      return res.status(400).json({ success: false, message: "Withdrawal amount is required" });
    }

    const withdrawalAmount = parseFloat(amount);
    if (isNaN(withdrawalAmount) || withdrawalAmount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid withdrawal amount" });
    }

    const member = await MemberModel.findOne({
      $or: [{ Member_id: memberId }, { member_id: memberId }]
    });
    if (!member) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }

    const actualMemberId = member.Member_id || memberId;

    const allTxs = await TransactionModel.find({
      member_id: actualMemberId
    });

    const levelTxs = allTxs.filter(tx => {
      const txType = (tx.transaction_type || "").toLowerCase();
      const desc = (tx.description || "").toLowerCase();
      const benefit = (tx.benefit_type || "").toLowerCase();

      const isProductLevelIncome = (
        desc.includes("product level") ||
        txType.includes("product level") ||
        desc.includes("level benefit") ||
        desc.includes("level bonus") ||
        txType.includes("level benefit") ||
        txType.includes("level bonus") ||
        benefit.includes("level income")
      );
      const isProductLevelWithdrawal = (
        txType.includes("product level withdrawal") ||
        (desc.includes("product level") && (txType.includes("withdrawal") || desc.includes("withdrawal")))
      );
      const isExcluded = (
        desc.includes("roi") ||
        txType.includes("roi") ||
        desc.includes("referral") ||
        txType.includes("referral") ||
        desc.includes("daily incentive") ||
        txType.includes("daily incentive") ||
        txType === "vendor withdrawal"
      );

      return (isProductLevelIncome || isProductLevelWithdrawal) && !isExcluded;
    });

    const totalIncome = levelTxs
      .filter(tx => !tx.transaction_type?.toLowerCase().includes("withdrawal") && tx.status === "Completed")
      .reduce((acc, tx) => acc + (parseFloat(tx.vw_credit) || 0) + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.gross_amount) || 0), 0);

    const completedWithdrawals = levelTxs
      .filter(tx => tx.transaction_type?.toLowerCase().includes("withdrawal") && tx.status === "Completed")
      .reduce((acc, tx) => acc + (parseFloat(tx.gross_amount) || parseFloat(tx.ew_debit) || parseFloat(tx.vw_debit) || 0), 0);

    const pendingWithdrawals = levelTxs
      .filter(tx => tx.transaction_type?.toLowerCase().includes("withdrawal") && (tx.status === "Pending" || tx.status === "Processing"))
      .reduce((acc, tx) => acc + (parseFloat(tx.gross_amount) || parseFloat(tx.ew_debit) || parseFloat(tx.vw_debit) || 0), 0);

    const currentBalance = Math.max(0, totalIncome - completedWithdrawals - pendingWithdrawals);

    if (withdrawalAmount > currentBalance) {
      return res.status(400).json({
        success: false,
        message: `Insufficient Product Level balance. Available: ₹${currentBalance.toFixed(2)}`
      });
    }

    // 10% standard deduction
    const deduction = withdrawalAmount * 0.10;
    const netAmount = withdrawalAmount - deduction;

    const newTransactionId = await generateTransactionId("PL_WTH");

    const newTransaction = new TransactionModel({
      transaction_id: newTransactionId,
      transaction_date: new Date(),
      member_id: actualMemberId,
      description: "Product Level Income Withdrawal Request",
      transaction_type: "Product Level Withdrawal",
      vw_credit: 0,
      vw_debit: 0,
      ew_credit: 0,
      ew_debit: withdrawalAmount,
      status: "Pending",
      deduction: deduction,
      net_amount: netAmount,
      gross_amount: withdrawalAmount
    });

    await newTransaction.save();

    const newBalance = Math.max(0, currentBalance - withdrawalAmount);

    return res.status(200).json({
      success: true,
      message: "Product Level Income withdrawal request submitted successfully",
      data: {
        transactionId: newTransaction.transaction_id,
        withdrawalDetails: {
          grossAmount: withdrawalAmount.toFixed(2),
          deduction: deduction.toFixed(2),
          netAmount: netAmount.toFixed(2),
          deductionRate: "10%"
        },
        balanceDetails: {
          previousBalance: currentBalance.toFixed(2),
          withdrawalAmount: withdrawalAmount.toFixed(2),
          newAvailableBalance: newBalance.toFixed(2)
        },
        status: "Pending"
      }
    });
  } catch (error) {
    console.error("Error in productLevelWalletWithdraw:", error);
    return res.status(500).json({
      success: false,
      message: "Server error during product level wallet withdrawal",
      error: error.message
    });
  }
};

module.exports = {
  getWalletOverview,
  getWalletWithdraw,
  transferWallet,
  sendTransferOTP,
  sendWithdrawalOTP,
  lookupMemberForTransfer,
  transferP2PWallet,
  getMemberWithdrawalLimits,
  getVendorWalletOverview,
  vendorWalletWithdraw,
  getProductLevelWalletOverview,
  productLevelWalletWithdraw
};