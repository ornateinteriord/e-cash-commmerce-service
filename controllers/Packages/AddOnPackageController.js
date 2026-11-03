const AddOnRequestModel = require("../../models/Packages/AddOnRequest");
const AddOnPackageModel = require("../../models/Packages/AddOnPackage");
const MemberModel = require("../../models/Users/Member");
const AccountsModel = require("../../models/accounts.model");
const AccountGroupModel = require("../../models/accountGroup.model");
const mlmService = require("../Users/mlmService/mlmService");
const { processAddOnROI, processMemberROI } = require("../Users/roiService/roiService");
const PayoutModel = require("../../models/Payout/Payout");
const TransactionModel = require("../../models/Transaction/Transaction");
const moment = require("moment");
const ReceiptsModel = require("../../models/receipts.model");
const generateTransactionId = require("../../utils/generateTransactionId");
const { sendMail } = require("../../utils/EmailService");
const { generateTopUpApprovedEmail } = require("../../utils/generateMSCSEmail");// User requests a new addon package layer
const requestAddOn = async (req, res) => {
  try {
    const { member_id, requested_amount, tx_no, screenshot_url, payment_method } = req.body;

    if (!member_id || !requested_amount) {
      return res.status(400).json({ success: false, message: "Member ID and Amount are required" });
    }

    if (Number(requested_amount) < 100) {
      return res.status(400).json({ success: false, message: "Minimum package amount is ₹100" });
    }

    const member = await MemberModel.findOne({ Member_id: member_id });
    if (!member) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }

    // Require total earnings >= 2 * totalInvested for re-investment / add-on
    const existingAddons = await AddOnPackageModel.find({ member_id, request_id: { $ne: 'PRIMARY' } });
    const totalAddonAmount = existingAddons.reduce((acc, pkg) => acc + (parseFloat(pkg.amount) || 0), 0);
    const primaryAmount = parseFloat(member.package_value) || 0;
    const totalInvested = primaryAmount + totalAddonAmount;

    if (totalInvested > 0) {
      const memberTxs = await TransactionModel.find({
        member_id,
        status: "Completed"
      });
      const levelBenefits = memberTxs.filter(tx => {
        const txType = tx.transaction_type?.toLowerCase() || "";
        const desc = tx.description?.toLowerCase() || "";
        return (txType.includes("level benefit") || txType.includes("level bonus") || tx.benefit_type?.toLowerCase().includes("level income")) &&
          !txType.includes("roi") && !desc.includes("roi") && !txType.includes("referral") && !desc.includes("referral");
      }).reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.uw_credit) || 0) + (parseFloat(tx.fd_credit) || 0) + (parseFloat(tx.pw_credit) || 0), 0);

      const roiLevelBenefits = memberTxs.filter(tx => tx.transaction_type === "ROI Level Benefit").reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.uw_credit) || 0) + (parseFloat(tx.fd_credit) || 0) + (parseFloat(tx.pw_credit) || 0), 0);
      const directBenefits = memberTxs.filter(tx => {
        const txType = tx.transaction_type?.toLowerCase() || "";
        const desc = tx.description?.toLowerCase() || "";
        return txType === "direct benefits" || desc === "direct benefits" || txType.includes("referral") || desc.includes("referral");
      }).reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.uw_credit) || 0) + (parseFloat(tx.fd_credit) || 0) + (parseFloat(tx.pw_credit) || 0), 0);
      const repaymentCommission = memberTxs.filter(tx => (tx.transaction_type?.toLowerCase().includes("repayment commission") || tx.description?.toLowerCase().includes("repayment commission"))).reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0), 0);
      const roiBenefits = memberTxs.filter(tx => tx.transaction_type === "ROI Payout").reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.uw_credit) || 0) + (parseFloat(tx.fd_credit) || 0) + (parseFloat(tx.pw_credit) || 0), 0);
      const singleLineIncome = memberTxs.filter(tx => (
        tx.transaction_type === "Daily Incentive" ||
        tx.transaction_type === "Single Line Income" ||
        tx.transaction_type === "Single Level Income" ||
        tx.transaction_type === "Single Leg Income" ||
        tx.transaction_type === "ROI Payout" ||
        tx.description?.toLowerCase().includes("daily incentive")
      )).reduce((acc, tx) => acc + (parseFloat(tx.gross_amount) || parseFloat(tx.net_amount) || ((parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.tw_credit) || 0)) || parseFloat(tx.ew_credit) || 0), 0);

      const totalEarnings = levelBenefits + roiLevelBenefits + directBenefits + repaymentCommission + roiBenefits + singleLineIncome;

      if (totalEarnings < (2 * totalInvested)) {
        return res.status(400).json({
          success: false,
          message: `Re-investment is allowed only when total earnings reach at least double of your investment amount (₹${(2 * totalInvested).toLocaleString()}). Current earnings: ₹${totalEarnings.toLocaleString()}.`
        });
      }
    }

    const method = payment_method || "crypto";

    // Non-wallet payments (UPI/QR, crypto) require a transaction reference number
    if (method !== "wallet") {
      if (!tx_no || !tx_no.toString().trim()) {
        return res.status(400).json({
          success: false,
          message: "Transaction reference number (UTR / Txn Ref) is required",
        });
      }
    }

    const cleanTxNo = tx_no ? tx_no.toString().trim() : "";
    let generatedTxNo = cleanTxNo || null;

    if (cleanTxNo && method !== "wallet") {
      // Exact case-insensitive match for transaction reference
      const escapedTx = cleanTxNo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const txRegex = new RegExp(`^${escapedTx}$`, "i");

      // 1. Check existing pending or approved requests in AddOnRequestModel
      const existingRequest = await AddOnRequestModel.findOne({
        tx_no: { $regex: txRegex },
        status: { $in: ["PENDING", "APPROVED"] },
      });

      if (existingRequest) {
        if (existingRequest.status === "PENDING") {
          return res.status(400).json({
            success: false,
            message: `Transaction reference number "${cleanTxNo}" has already been submitted and is currently pending verification. Each transaction reference number must be unique.`,
          });
        }
        return res.status(400).json({
          success: false,
          message: `Transaction reference number "${cleanTxNo}" has already been approved and credited. Each transaction reference number must be unique.`,
        });
      }

      // 2. Check if already recorded in TransactionModel
      const existingTx = await TransactionModel.findOne({
        $or: [
          { reference_no: { $regex: txRegex } },
          { transaction_id: cleanTxNo },
        ],
        status: { $in: ["Completed", "Approved", "Pending", "active"] },
      });

      if (existingTx) {
        return res.status(400).json({
          success: false,
          message: `Transaction reference number "${cleanTxNo}" has already been processed in the system. Each transaction reference number must be unique.`,
        });
      }
    }

    if (method === "wallet") {
      const transactions = await TransactionModel.find({ member_id });
      const nonLoanTransactions = transactions.filter(tx =>
        !tx.transaction_type?.toLowerCase().includes('loan') &&
        !tx.description?.toLowerCase().includes('loan')
      );
      const completedAndPendingTx = nonLoanTransactions.filter(tx =>
        tx.status === "Completed" || tx.status === "Pending" || tx.status === "Approved"
      );
      const availableBalance = completedAndPendingTx.reduce((acc, tx) =>
        acc + (parseFloat(tx.ew_credit) || 0) - (parseFloat(tx.ew_debit) || 0), 0
      );

      if (availableBalance < Number(requested_amount)) {
        return res.status(400).json({ success: false, message: "Insufficient wallet balance." });
      }

      await MemberModel.findOneAndUpdate(
        { Member_id: member_id },
        { $inc: { wallet_balance: -Number(requested_amount) } }
      );

      const newTransactionId = await generateTransactionId("PUR");

      const newTransaction = new TransactionModel({
        transaction_id: newTransactionId.toString(),
        transaction_date: new Date(),
        member_id: member_id,
        Name: member.Name,
        mobileno: member.mobileno,
        description: "Package Purchase Deduction",
        transaction_type: "Package Purchase",
        ew_credit: 0,
        ew_debit: Number(requested_amount),
        status: "Completed",
        net_amount: Number(requested_amount),
        gross_amount: Number(requested_amount)
      });
      await newTransaction.save();
      generatedTxNo = newTransaction.transaction_id;
    }

    const request_id = `AOR${Date.now()}`;
    const newRequest = new AddOnRequestModel({
      request_id,
      member_id,
      requested_amount: Number(requested_amount),
      payment_method: method,
      tx_no: generatedTxNo,
      screenshot_url: method === "wallet" ? null : screenshot_url
    });

    await newRequest.save();

    res.status(201).json({ success: true, message: "Load Fund request submitted successfully", request: newRequest });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Admin gets list of ALL requests 
const getAllRequests = async (req, res) => {
  try {
    const requests = await AddOnRequestModel.find().sort({ createdAt: -1 });
    res.status(200).json({ success: true, requests });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get all approved add-ons for a specific member (user dashboard)
const getMemberAddOns = async (req, res) => {
  try {
    const { member_id } = req.params;

    // 1. Fetch standard add-on packages
    const addons = await AddOnPackageModel.find({
      member_id
    }).sort({ createdAt: 1 });

    // 2. Fetch FD accounts from accounts_tbl
    // First get the group IDs for FD
    const fdGroups = await AccountGroupModel.find({
      account_group_name: { $regex: /FIXED DEPOSIT|FD/i }
    }).select('account_group_id');

    const fdGroupIds = fdGroups.map(g => g.account_group_id);

    const fdAccounts = await AccountsModel.find({
      member_id: member_id,
      $or: [
        { account_type: { $in: fdGroupIds } },
        { account_no: { $regex: /^FD/i } }
      ],
      status: { $ne: "closed" }
    });

    // 3. Map FD accounts to look like addons
    const mappedFDs = fdAccounts.map(acc => {
      // Calculate progress for FD if possible
      let progressCount = 0;
      if (acc.date_of_opening && acc.date_of_maturity) {
        const start = moment(acc.date_of_opening);
        const end = moment(acc.date_of_maturity);
        const now = moment();
        const totalDays = end.diff(start, 'days');
        const elapsedDays = now.diff(start, 'days');

        if (totalDays > 0) {
          // Map to 300 scale for frontend compatibility if needed, 
          // or we'll handle it in frontend
          progressCount = Math.max(0, Math.min(elapsedDays, totalDays));
          // If we want to use the frontend's /300 logic:
          // progressCount = (elapsedDays / totalDays) * 300;
        }
      }

      return {
        package_id: acc.account_no || acc.account_id,
        member_id: acc.member_id,
        amount: acc.account_amount,
        roi_status: acc.status === 'active' ? 'Active' : 'Pending',
        roi_payout_target: acc.net_amount || (acc.account_amount + (acc.interest_amount || 0)),
        roi_payout_count: progressCount,
        roi_start_date: acc.date_of_opening,
        isFD: true,
        interest_rate: acc.interest_rate,
        duration: acc.duration,
        date_of_maturity: acc.date_of_maturity,
        account_type_name: "Fixed Deposit"
      };
    });

    // Combine them
    const combinedAddOns = [...addons, ...mappedFDs];

    res.status(200).json({ success: true, addons: combinedAddOns });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Admin Approves/Rejects the request
const evaluateRequest = async (req, res) => {
  try {
    const { request_id } = req.params;
    const { status, admin_id } = req.body; // 'APPROVED' or 'REJECTED'

    if (!["APPROVED", "REJECTED"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    const request = await AddOnRequestModel.findOne({ request_id });
    if (!request) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }

    if (request.status !== "PENDING") {
      return res.status(400).json({ success: false, message: "Request already evaluated" });
    }

    request.status = status;
    request.admin_audit = {
      admin_id: admin_id || "SYSTEM",
      timestamp: new Date()
    };

    if (status === "APPROVED") {
      const member = await MemberModel.findOne({ Member_id: request.member_id });
      if (!member) {
        return res.status(404).json({ success: false, message: "Member not found" });
      }

      try {
        const topUpTxId = await generateTransactionId("DEP");
        const creditTransaction = new TransactionModel({
          transaction_id: topUpTxId.toString(),
          transaction_date: new Date(),
          member_id: request.member_id,
          Name: member.Name,
          mobileno: member.mobileno,
          description: "Add Credits",
          transaction_type: "Credit Deposit",
          ew_credit: request.requested_amount,
          ew_debit: 0,
          status: "Completed",
          net_amount: request.requested_amount,
          gross_amount: request.requested_amount,
          reference_no: request.tx_no || request.request_id
        });
        await creditTransaction.save();

        // Increment the Credits Wallet (wallet_balance) in the Member table
        await MemberModel.findOneAndUpdate(
          { Member_id: request.member_id },
          { $inc: { wallet_balance: Number(request.requested_amount) } }
        );

        console.log(`✅ Credits Wallet credited: ₹${request.requested_amount} for ${request.member_id}`);

        // Send Email Notification
        const memberEmail = member.Email || member.email;
        if (memberEmail) {
          const { htmlContent, subject } = generateTopUpApprovedEmail(member.Name, request.requested_amount);
          const attachments = [{
            filename: 'BMS.png',
            path: require('path').join(__dirname, '../../utils/BMS.png'),
            cid: 'bmslogo'
          }];
          await sendMail(memberEmail, subject, htmlContent, "Top Up Approved", attachments);
          console.log(`📧 Top Up approval email sent to ${memberEmail}`);
        }

      } catch (topUpErr) {
        console.error(`❌ Top Up transaction creation failed for ${request_id}:`, topUpErr.message);
      }
    } else if (status === "REJECTED") {
      if (request.payment_method === "wallet") {
        const member = await MemberModel.findOne({ Member_id: request.member_id });
        if (member) {
          await MemberModel.findOneAndUpdate(
            { Member_id: request.member_id },
            { $inc: { wallet_balance: Number(request.requested_amount) } }
          );

          const newTransactionId = await generateTransactionId("REF");

          const newTransaction = new TransactionModel({
            transaction_id: newTransactionId.toString(),
            transaction_date: new Date(),
            member_id: request.member_id,
            Name: member.Name,
            mobileno: member.mobileno,
            description: "Package Purchase Refund (Rejected)",
            transaction_type: "Refund",
            ew_credit: Number(request.requested_amount),
            ew_debit: 0,
            status: "Completed",
            net_amount: Number(request.requested_amount),
            gross_amount: Number(request.requested_amount)
          });
          await newTransaction.save();
        }
      }
    }

    await request.save();

    res.status(200).json({ success: true, message: `Request successfully ${status.toLowerCase()}`, request });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const getMemberRequests = async (req, res) => {
  try {
    const { member_id } = req.params;
    const requests = await AddOnRequestModel.find({ member_id }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, requests });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// User instantly buys a package using Top Up Wallet
const buyPackageDirectly = async (req, res) => {
  try {
    const { member_id, requested_amount, target_member_id } = req.body;

    if (!member_id || !requested_amount) {
      return res.status(400).json({ success: false, message: "Member ID and Amount are required" });
    }

    if (Number(requested_amount) < 100) {
      return res.status(400).json({ success: false, message: "Minimum package amount is ₹100" });
    }

    const finalTargetId = target_member_id || member_id;

    const payer = await MemberModel.findOne({ Member_id: member_id });
    if (!payer) {
      return res.status(404).json({ success: false, message: "Payer member not found" });
    }

    const targetMember = await MemberModel.findOne({ Member_id: finalTargetId });
    if (!targetMember) {
      return res.status(404).json({ success: false, message: "Target member not found" });
    }

    // 0. Check if invest amount already active
    if (Number(targetMember.package_value) === Number(requested_amount)) {
      return res.status(400).json({ success: false, message: "You have already invested this amount." });
    }

    const existingAddOn = await AddOnPackageModel.findOne({ member_id: finalTargetId, amount: Number(requested_amount) });
    if (existingAddOn) {
      return res.status(400).json({ success: false, message: "You have already invested this amount." });
    }

    // 0.1 Check if this is a re-investment and require total earnings >= 2 * totalInvested
    const memberIdVal = targetMember.Member_id || finalTargetId;
    const existingAddons = await AddOnPackageModel.find({ member_id: memberIdVal, request_id: { $ne: 'PRIMARY' } });
    const totalAddonAmount = existingAddons.reduce((acc, pkg) => acc + (parseFloat(pkg.amount) || 0), 0);
    const primaryAmount = parseFloat(targetMember.package_value) || 0;
    const totalInvested = primaryAmount + totalAddonAmount;

    if (totalInvested > 0) {
      const memberTxs = await TransactionModel.find({
        member_id: memberIdVal,
        status: "Completed"
      });
      const levelBenefits = memberTxs.filter(tx => {
        const txType = tx.transaction_type?.toLowerCase() || "";
        const desc = tx.description?.toLowerCase() || "";
        return (txType.includes("level benefit") || txType.includes("level bonus") || tx.benefit_type?.toLowerCase().includes("level income")) &&
          !txType.includes("roi") && !desc.includes("roi") && !txType.includes("referral") && !desc.includes("referral");
      }).reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.uw_credit) || 0) + (parseFloat(tx.fd_credit) || 0) + (parseFloat(tx.pw_credit) || 0), 0);

      const roiLevelBenefits = memberTxs.filter(tx => tx.transaction_type === "ROI Level Benefit").reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.uw_credit) || 0) + (parseFloat(tx.fd_credit) || 0) + (parseFloat(tx.pw_credit) || 0), 0);
      const directBenefits = memberTxs.filter(tx => {
        const txType = tx.transaction_type?.toLowerCase() || "";
        const desc = tx.description?.toLowerCase() || "";
        return txType === "direct benefits" || desc === "direct benefits" || txType.includes("referral") || desc.includes("referral");
      }).reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.uw_credit) || 0) + (parseFloat(tx.fd_credit) || 0) + (parseFloat(tx.pw_credit) || 0), 0);
      const repaymentCommission = memberTxs.filter(tx => (tx.transaction_type?.toLowerCase().includes("repayment commission") || tx.description?.toLowerCase().includes("repayment commission"))).reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0), 0);
      const roiBenefits = memberTxs.filter(tx => tx.transaction_type === "ROI Payout").reduce((acc, tx) => acc + (parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.uw_credit) || 0) + (parseFloat(tx.fd_credit) || 0) + (parseFloat(tx.pw_credit) || 0), 0);
      const singleLineIncome = memberTxs.filter(tx => (
        tx.transaction_type === "Daily Incentive" ||
        tx.transaction_type === "Single Line Income" ||
        tx.transaction_type === "Single Level Income" ||
        tx.transaction_type === "Single Leg Income" ||
        tx.transaction_type === "ROI Payout" ||
        tx.description?.toLowerCase().includes("daily incentive")
      )).reduce((acc, tx) => acc + (parseFloat(tx.gross_amount) || parseFloat(tx.net_amount) || ((parseFloat(tx.ew_credit) || 0) + (parseFloat(tx.tw_credit) || 0)) || parseFloat(tx.ew_credit) || 0), 0);

      const totalEarnings = levelBenefits + roiLevelBenefits + directBenefits + repaymentCommission + roiBenefits + singleLineIncome;

      if (totalEarnings < (2 * totalInvested)) {
        return res.status(400).json({
          success: false,
          message: `Re-investment is allowed only when total earnings reach at least double of your investment amount (₹${(2 * totalInvested).toLocaleString()}). Current earnings: ₹${totalEarnings.toLocaleString()}.`
        });
      }
    }

    // 1. Verify Credits Balance for Payer
    const transactions = await TransactionModel.find({ member_id: member_id });
    const nonLoanTransactions = transactions.filter(tx =>
      !tx.transaction_type?.toLowerCase().includes('loan') &&
      !tx.description?.toLowerCase().includes('loan')
    );
    const completedAndPendingTx = nonLoanTransactions.filter(tx =>
      tx.status === "Completed" || tx.status === "Pending" || tx.status === "Approved"
    );
    const availableBalance = completedAndPendingTx.reduce((acc, tx) =>
      acc + (parseFloat(tx.ew_credit) || 0) - (parseFloat(tx.ew_debit) || 0), 0
    );
    const creditsBalance = Math.max(availableBalance, payer.wallet_balance || 0);

    if (creditsBalance < Number(requested_amount)) {
      return res.status(400).json({ success: false, message: "Insufficient Credits Balance." });
    }

    // 2. Deduct from Credits Balance (Payer)
    const newTxId = await generateTransactionId("INV");

    let description = "Direct Invest Amount";
    if (member_id !== finalTargetId) {
      description = `Invest Amount for ${finalTargetId}`;
    }

    const deductionTx = new TransactionModel({
      transaction_id: newTxId.toString(),
      transaction_date: new Date(),
      member_id: member_id,
      Name: payer.Name,
      mobileno: payer.mobileno,
      description: description,
      transaction_type: "Invest Amount",
      ew_credit: 0,
      ew_debit: Number(requested_amount),
      status: "Completed",
      net_amount: Number(requested_amount),
      gross_amount: Number(requested_amount),
      balance: (creditsBalance - Number(requested_amount)).toString()
    });
    await deductionTx.save();

    // Deduct the Credits balance in the Member table
    await MemberModel.findOneAndUpdate(
      { Member_id: member_id },
      { $inc: { wallet_balance: -Number(requested_amount) } }
    );

    // 3. Activate Investment & Daily Incentive for Target Member
    const request_id = `DIR${Date.now()}`; // Pseudo request ID for tracking

    // CASE A: Primary Package
    const todayStr = moment().utcOffset("+05:30").format("YYYY-MM-DD");
    if (!targetMember.package_value || targetMember.package_value === 0) {
      targetMember.package_value = requested_amount;
      targetMember.spackage = `PKG-${requested_amount}`;
      targetMember.status = "active";
      targetMember.roi_status = "Active";
      targetMember.roi_payout_count = 0;
      targetMember.roi_payout_target = 400;
      targetMember.roi_daily_amount = Math.round(Number(requested_amount) * 0.005 * 100) / 100;
      targetMember.roi_total_paid = 0;
      if (targetMember.level === undefined || targetMember.level === null) {
        targetMember.level = 0;
      }
      targetMember.roi_start_date = todayStr;
      targetMember.roi_last_payout_date = null;
      await targetMember.save();
    }
    // CASE B: Add-On Package
    else {
      const newAddOn = new AddOnPackageModel({
        package_id: `PKG-A-${Date.now()}`,
        member_id: finalTargetId,
        amount: requested_amount,
        roi_status: "Active",
        roi_payout_count: 0,
        roi_payout_target: 400,
        roi_start_date: todayStr,
        roi_last_payout_date: null,
        request_id: request_id,
        admin_id: "SYSTEM_DIRECT"
      });
      await newAddOn.save();
    }

    // try {
    //   const { distributeGlobalIncome } = require("./globalIncomeService");
    //   await distributeGlobalIncome(finalTargetId, requested_amount);
    // } catch (globalIncomeErr) {
    //   console.error("Global income distribution failed:", globalIncomeErr);
    // }

    // 4. Check and Update Sponsor Level & Continuous ROI
    try {
      const { checkAndUpdateSponsorLevel } = require("../Users/roiService/sponsorLevelService");
      const sponsorIdentifier = targetMember.sponsor_id || targetMember.Sponsor_code;
      if (sponsorIdentifier) {
        await checkAndUpdateSponsorLevel(sponsorIdentifier);
      }
    } catch (lvlErr) {
      console.error(`⚠️ Sponsor level promotion check failed:`, lvlErr.message);
    }

    // 4.1 MLM Commissions - For Target Member's Sponsor
    try {
      const commissions = await mlmService.calculateCommissions(
        finalTargetId,
        targetMember.sponsor_id,
        requested_amount,
        "Invest Amount"
      );
      if (commissions.length > 0) {
        await mlmService.processCommissions(commissions);
      }
    } catch (commErr) {
      console.error(`⚠️ Commission distribution failed:`, commErr.message);
    }

    // 5. Banking Receipt
    try {
      const lastReceipt = await ReceiptsModel.findOne().sort({ receipt_id: -1 }).limit(1);
      let newReceiptId = "RPT0001";
      if (lastReceipt && lastReceipt.receipt_id) {
        const numericPart = lastReceipt.receipt_id.replace(/^RPT/, '');
        const lastId = parseInt(numericPart);
        if (!isNaN(lastId)) {
          newReceiptId = `RPT${(lastId + 1).toString().padStart(4, '0')}`;
        }
      }

      await ReceiptsModel.create({
        receipt_id: newReceiptId,
        receipt_date: new Date(),
        received_from: payer.Name,
        receipt_details: `Direct Invest Amount ${member_id !== finalTargetId ? 'for ' + finalTargetId : ''} - ${requested_amount}`,
        mode_of_payment_received: "Credits Wallet",
        amount: requested_amount,
        status: "active",
        ref_no: request_id,
        receipt_no: `REC-${Date.now()}`,
        entered_by: "SYSTEM_DIRECT",
        branch_code: payer.branch_id || "BRN001",
        member_id: member_id
      });
    } catch (receiptErr) {
      console.error(`❌ Banking Receipt generation failed:`, receiptErr.message);
    }

    res.status(200).json({ success: true, message: `Invest Amount processed successfully!` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  requestAddOn,
  getAllRequests,
  getMemberAddOns,
  evaluateRequest,
  getMemberRequests,
  buyPackageDirectly
};

