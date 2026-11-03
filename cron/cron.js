const cron = require("node-cron");
const { processDailyROI } = require("../controllers/Users/roiService/roiService");
const { processAutoUpgrades } = require("../controllers/Packages/autoUpgradeService");
const { cleanDuplicateReferralBonus } = require("../controllers/Users/Payout/PayoutController");

/**
 * Initialize all cron jobs for the application
 */
const initCronJobs = () => {
    // 1. Daily ROI & Daily Incentive Payout at 12:00 AM Every Day (Monday through Sunday including weekends)
    cron.schedule("00 00 * * *", async () => {
        console.log("⏰ [CRON] Triggering Daily ROI Distribution (Every Day) at 12:00 AM IST...");
        try {
            const result = await processDailyROI();
            console.log("✅ [CRON] Daily ROI Payout completed:", result);
        } catch (error) {
            console.error("❌ [CRON] Error in Daily ROI Payout:", error.message);
        }
    }, {
        timezone: "Asia/Kolkata"
    });

    console.log("📅 [CRON] Scheduler initialized: Daily ROI at 12:00 AM Every Day (Asia/Kolkata).");

    // 2. Auto Upgrade Wallet Check at 01:00 AM every day (Asia/Kolkata)
    cron.schedule("00 01 * * *", async () => {
        console.log("⏰ [CRON] Triggering Auto Upgrade Wallet Process at 01:00 AM IST...");
        try {
            const result = await processAutoUpgrades();
            console.log("✅ [CRON] Auto Upgrade Wallet Process completed:", result);
        } catch (error) {
            console.error("❌ [CRON] Error in Auto Upgrade Wallet Process:", error.message);
        }
    }, {
        timezone: "Asia/Kolkata"
    });

    console.log("📅 [CRON] Scheduler initialized: Auto Upgrade Wallet at 01:00 AM (Asia/Kolkata).");

    // 3. Immediate check on startup (Catch-up logic and auto duplicate cleanup)
    setTimeout(async () => {
        console.log("⏰ [CRON] Running Startup ROI Check, Auto-Upgrade & Duplicate Cleanup...");

        // Auto-clean any duplicate referral bonuses
        try {
            const dupResult = await cleanDuplicateReferralBonus();
            if (dupResult && dupResult.success) {
                console.log(`🧹 [CRON] Duplicate Referral Check: ${dupResult.message}`);
            }
        } catch (dupErr) {
            console.error("❌ [CRON] Error checking duplicate referral bonus:", dupErr.message);
        }

        try {
            const result = await processDailyROI();
            if (result.processedCount > 0) {
                console.log(`✅ [CRON] Startup ROI Catch-up completed. Processed: ${result.processedCount} payouts.`);
            } else {
                console.log("📅 [CRON] Startup ROI Check: All records are up to date.");
            }
        } catch (error) {
            console.error("❌ [CRON] Error in Startup ROI Catch-up:", error.message);
        }

        try {
            const autoUpgradeResult = await processAutoUpgrades();
            if (autoUpgradeResult && autoUpgradeResult.processedCount > 0) {
                console.log(`✅ [CRON] Startup Auto-Upgrade completed. Processed: ${autoUpgradeResult.processedCount} upgrades.`);
            } else {
                console.log("📅 [CRON] Startup Auto-Upgrade: No eligible upgrades found.");
            }
        } catch (error) {
            console.error("❌ [CRON] Error in Startup Auto-Upgrade Catch-up:", error.message);
        }
    }, 5000);
};

module.exports = { initCronJobs };
