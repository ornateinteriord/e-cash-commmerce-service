const express = require("express");
const getTransactionDetails = require("../controllers/Transaction/Transaction");
const { getEpins, transferEpin, getPackageHistory } = require("../controllers/Users/Epin/epin");
const {
  getMemberDetails,
  UpdateMemberDetails,
  activateMemberPackage,
} = require("../controllers/Users/Profile/Profile");
const { getSponsers, checkSponsorReward } = require("../controllers/Users/Sponser/sponser");
const { getMultiLevelSponsorship } = require("../controllers/Users/Sponser/multiLevelSponsorship");
const { createTicket, getTickets } = require("../controllers/Users/Ticket/TicketConntroller");
const Authenticated = require("../middlewares/auth");
const {  triggerMLMCommissions, getMemberCommissionSummary, getDailyPayout, climeRewardLoan, repaymentLoan, getROIBenefits, triggerUserROI, getLevelRoiSchedules } = require("../controllers/Users/Payout/PayoutController");
const { getPendingTransactions, approveWithdrawal, rejectWithdrawal } = require("../controllers/Users/payoutPending/pendingTransactions");
const { getWalletOverview, getWalletWithdraw, transferWallet, sendTransferOTP, sendWithdrawalOTP, lookupMemberForTransfer, transferP2PWallet, getVendorWalletOverview, vendorWalletWithdraw, getProductLevelWalletOverview, productLevelWalletWithdraw } = require("../controllers/Users/walletServiece/walletServies");
const { getMemberCommissionTransactions } = require("../controllers/Member");
const { getUplineTree } = require("../controllers/Users/mlmService/mlmService");

const router = express.Router();


router.get("/member/:id", Authenticated, getMemberDetails);
router.get("/get-commission-transactions/:memberId", Authenticated, getMemberCommissionTransactions);
router.put("/member/:memberId", Authenticated, UpdateMemberDetails);
router.put("/activate-package/:memberId", Authenticated, activateMemberPackage);


router.get("/transactions", Authenticated, getTransactionDetails);
router.get("/trasactions/:status", getPendingTransactions);


router.post("/ticket", Authenticated, createTicket);
router.get("/ticket/:id", Authenticated, getTickets);


router.get("/epin", Authenticated, getEpins);
router.put('/transferPackage', Authenticated, transferEpin);
router.get('/package-history', Authenticated, getPackageHistory);
router.get("/sponser/:memberId", Authenticated, getSponsers);
router.get("/sponsers/:memberId", Authenticated, getSponsers);
router.get("/sponser-tree/:id", Authenticated, getMultiLevelSponsorship);
router.get("/multi-level-sponsors", Authenticated, getMultiLevelSponsorship);
router.get("/upline-tree/:id", Authenticated, getUplineTree);
router.get("/check-sponsor-reward/:memberId", Authenticated, checkSponsorReward);
router.get("/check-sponsor-reward", Authenticated, checkSponsorReward);
router.get("/commissions/summary/:member_id", Authenticated, getMemberCommissionSummary);
router.get("/trigger-commissions", triggerMLMCommissions);


router.get("/overview/:memberId", Authenticated, getWalletOverview);
router.post("/withdraw/:memberId", Authenticated, getWalletWithdraw);
router.post("/withdraw/send-otp/:memberId", Authenticated, sendWithdrawalOTP);
router.post("/transfer-wallet", Authenticated, transferWallet);
router.post("/transfer-wallet/send-otp", Authenticated, sendTransferOTP);
router.get("/transfer-lookup", Authenticated, lookupMemberForTransfer);
router.post("/transfer-p2p", Authenticated, transferP2PWallet);
router.put('/approve-withdrawal/:transaction_id', Authenticated, approveWithdrawal);
router.put('/reject-withdrawal/:transaction_id', Authenticated, rejectWithdrawal);

// Vendor Wallet Routes (Separate functions)
router.get("/vendor-wallet/overview/:memberId", Authenticated, getVendorWalletOverview);
router.post("/vendor-wallet/withdraw/:memberId", Authenticated, vendorWalletWithdraw);

// Product Level Wallet Routes (Strictly Product Level Income)
router.get("/product-level-wallet/overview/:memberId", Authenticated, getProductLevelWalletOverview);
router.post("/product-level-wallet/withdraw/:memberId", Authenticated, productLevelWalletWithdraw);


router.get("/level-benefits/:member_id", Authenticated, getMemberCommissionSummary);
router.get("/level-benefits", Authenticated, getMemberCommissionSummary);
// User-specific daily payout (requires member_id parameter)
router.get("/daily-payout/:member_id", Authenticated, getDailyPayout);
router.get("/roi/trigger/:member_id", Authenticated, triggerUserROI);
router.get("/roi-benefits/:member_id", Authenticated, getROIBenefits);
router.get("/level-roi-schedules/:member_id", Authenticated, getLevelRoiSchedules);
router.get("/level-roi-schedules", Authenticated, getLevelRoiSchedules);
router.post("/clime-reward-loan/:memberId",climeRewardLoan)

router.post("/repayment-loan/:memberId",repaymentLoan)

module.exports = router;
// Cashfree payments (moved from PaymentRoutes)
