const { getHoliday, addHoliday } = require("../controllers/Admin/Holiday/HolidayController");
const { getNews, addNews } = require("../controllers/Admin/News/NewsController");
const UpdatePassword = require("../controllers/Admin/UpdatePassword");
const getTransactionDetails = require("../controllers/Transaction/Transaction");
const { getEpinsSummary, generatePackage } = require("../controllers/Users/Epin/epin");
const { getDailyPayout,   getRewardLoansByStatus, processRewardLoan, triggerDailyROI, getROISummary, getROIBenefits, getLevelRoiSchedules } = require("../controllers/Users/Payout/PayoutController");
const { processAutoUpgrades } = require("../controllers/Packages/autoUpgradeService");

// NIDHI ADMIN CONTROLLERS
const { createMember, getMembers: getNidhiMembers, updateMember: updateNidhiMember, getMemberById: getNidhiMemberById, setIntroducerHierarchy } = require("../controllers/Admin/Member/index");
const { createAgent, getAgents, updateAgent, getAgentById } = require("../controllers/Admin/Agent/index");
const { createInterest, getInterests, updateInterest, getInterestById } = require("../controllers/Admin/Interest/index");
const { getInterestsByAccountGroup, createAccount, getAccounts, getAccountById: getNidhiAccountById, updateAccount, getAccountBooks, getAccountGroups, getPreMaturityAccounts, getPostMaturityAccounts, getAccountTransactions, getAccountsForAssignment, updateAccountAssignment } = require("../controllers/Admin/Account/index");
const { getDashboardCounts, getRecentData } = require("../controllers/Admin/Dashboard/index");
const { createMaturityPayment } = require("../controllers/Admin/Banking/cashTransaction");


const { getMemberDetails, UpdateMemberDetails, getMember, updateMemberStatus } = require("../controllers/Users/Profile/Profile");
const { editTicket, getTickets } = require("../controllers/Users/Ticket/TicketConntroller");
const Authenticated = require("../middlewares/auth");
const authorizeRoles = require("../middlewares/authorizeRole");

const router = require("express").Router();

router.put("/update-password",Authenticated,authorizeRoles("ADMIN"),UpdatePassword)
router.get("/members",Authenticated,authorizeRoles("ADMIN"),getMemberDetails)
router.get("/transactions",Authenticated,authorizeRoles("ADMIN"),getTransactionDetails)
router.put("/ticket/:id" ,Authenticated,authorizeRoles("ADMIN"), editTicket)
router.get("/tickets" ,Authenticated,authorizeRoles("ADMIN"), getTickets)
router.get("/epin-summary" ,Authenticated,authorizeRoles("ADMIN"), getEpinsSummary)
router.put('/update-member/:memberId',Authenticated,authorizeRoles("ADMIN"),UpdateMemberDetails)
router.get('/get-member/:memberId',Authenticated,authorizeRoles("ADMIN"),getMember)
router.get('/getnews',Authenticated,authorizeRoles("ADMIN"),getNews)
router.post('/addnews',Authenticated,authorizeRoles("ADMIN"),addNews)
router.get('/getholiday',Authenticated,authorizeRoles("ADMIN"),getHoliday)
router.post('/addholiday',Authenticated,authorizeRoles("ADMIN"),addHoliday)
router.post('/generate-package',Authenticated,authorizeRoles("ADMIN"),generatePackage)
router.put('/update-status/:memberId', Authenticated, authorizeRoles("ADMIN"), updateMemberStatus)
// Admin can access all payouts or filter by member
router.get('/all-daily-payouts', Authenticated, authorizeRoles("ADMIN"), getDailyPayout);
router.get('/roi-summary', Authenticated, authorizeRoles("ADMIN"), getROISummary);
router.get('/roi-benefits', Authenticated, authorizeRoles("ADMIN"), getROIBenefits);
router.get('/level-roi-schedules', Authenticated, authorizeRoles("ADMIN"), getLevelRoiSchedules);
router.get('/level-roi-schedules/:member_id', Authenticated, authorizeRoles("ADMIN"), getLevelRoiSchedules);





router.get('/reward-loans/:status', getRewardLoansByStatus);

router.put('/reward-loans/:memberId/:action', processRewardLoan);
router.post('/trigger-roi', Authenticated, authorizeRoles("ADMIN"), triggerDailyROI);
router.post('/trigger-auto-upgrades', Authenticated, authorizeRoles("ADMIN"), async (req, res) => {
    try {
        const result = await processAutoUpgrades();
        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// ======================================================
//        NIDHI / ADMIN_01 BANKING ROUTES
// ======================================================

// Member routes
router.post('/create-member', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), createMember)
router.get('/get-members', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), getNidhiMembers)
router.put('/update-member/:memberId', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), updateNidhiMember)
router.get('/get-member/:memberId', Authenticated, authorizeRoles("ADMIN", "ADMIN_01", 'AGENT'), getNidhiMemberById)
router.put('/member/:memberId/set-hierarchy', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), setIntroducerHierarchy)

// Agent routes
router.post('/create-agent', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), createAgent)
router.get('/get-agents', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), getAgents)
router.put('/update-agent/:agentId', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), updateAgent)
router.get('/get-agent/:agentId', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), getAgentById)

// Interest routes
router.post('/create-interest', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), createInterest)
router.get('/get-interests', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), getInterests)
router.put('/update-interest/:interestId', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), updateInterest)
router.get('/get-interest/:interestId', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), getInterestById)

// Account routes
router.get('/get-interests-by-account-group/:account_group_id', Authenticated, authorizeRoles("ADMIN", "ADMIN_01", "AGENT"), getInterestsByAccountGroup)
router.post('/create-account', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), createAccount)
router.get('/get-accounts', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), getAccounts)
router.get('/get-account/:accountId', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), getNidhiAccountById)
router.put('/update-account/:accountId', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), updateAccount)
router.get('/get-account-books', Authenticated, authorizeRoles("ADMIN", "ADMIN_01", "AGENT"), getAccountBooks)
router.get('/get-account-groups', Authenticated, authorizeRoles("ADMIN", "ADMIN_01", "AGENT"), getAccountGroups)
router.get('/get-pre-maturity-accounts', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), getPreMaturityAccounts)
router.get('/get-post-maturity-accounts', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), getPostMaturityAccounts)
router.get('/accounts/transactions/:memberId', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), getAccountTransactions)

// Agent Assignment routes
router.get('/get-accounts-for-assignment', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), getAccountsForAssignment)
router.put('/update-account-assignment/:accountId', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), updateAccountAssignment)

// Dashboard routes
router.get('/get-dashboard-counts', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), getDashboardCounts)
router.get('/get-recent-data', Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), getRecentData)
router.post("/maturity-payment", Authenticated, authorizeRoles("ADMIN", "ADMIN_01"), createMaturityPayment);

module.exports = router;
