const MemberModel = require("../../../models/Users/Member");
const AddOnPackageModel = require("../../../models/Packages/AddOnPackage");
const TransactionModel = require("../../../models/Transaction/Transaction");
const LevelRoiScheduleModel = require("../../../models/Packages/LevelRoiSchedule");
const PayoutModel = require("../../../models/Payout/Payout");
const moment = require("moment");

// Lock management for global ROI processing
let isROIProcessing = false;
let lastGlobalProcessTime = 0;
const GLOBAL_LOCK_TIMEOUT = 10 * 60 * 1000; // 10 minutes

/**
 * Process daily ROI / Daily Incentive for all eligible members (Primary & Add-on packages).
 * Payout rules:
 * - 0.50% daily of the package/invested amount (e.g., ₹1.5 daily for ₹300)
 * - Duration: 200 days (target: 200 payouts)
 * - 100% credited to Credits Wallet (ew_credit / wallet_balance)
 * 
 * @param {string|null} targetMemberId - Optional member ID to process specifically
 * @param {string|null} customToday - Optional custom date override (YYYY-MM-DD)
 */
const processDailyROI = async (targetMemberId = null, customToday = null) => {
    const now = Date.now();
    if (isROIProcessing && (now - lastGlobalProcessTime < GLOBAL_LOCK_TIMEOUT)) {
        console.log("⚠️ ROI processing is already running. Skipping concurrent run.");
        return { success: false, message: "ROI processing already in progress" };
    }

    isROIProcessing = true;
    lastGlobalProcessTime = now;

    const todayStr = customToday || moment().utcOffset("+05:30").format("YYYY-MM-DD");
    let processedCount = 0;
    let baseProcessedCount = 0;
    let addonProcessedCount = 0;
    let levelRoiProcessedCount = 0;

    try {
        console.log(`⏰ [Daily Incentive] Starting Daily Incentive distribution for date: ${todayStr}...`);

        // ─────────────────────────────────────────────────────────────
        // 1. PROCESS PRIMARY PACKAGES (Stored directly in MemberModel)
        // ─────────────────────────────────────────────────────────────
        const memberQuery = {
            package_value: { $gt: 0 },
            status: "active",
            roi_status: { $ne: "Completed" }
        };

        if (targetMemberId) {
            memberQuery.Member_id = targetMemberId;
        }

        const activeMembers = await MemberModel.find(memberQuery);
        console.log(`🔍 [Daily Incentive] Found ${activeMembers.length} active members with primary packages.`);

        for (const member of activeMembers) {
            try {
                const pkgAmount = Number(member.package_value) || 0;
                if (pkgAmount <= 0) continue;

                const targetDays = member.roi_payout_target || 200;
                let currentCount = member.roi_payout_count || 0;

                if (currentCount >= targetDays) {
                    await MemberModel.updateOne(
                        { Member_id: member.Member_id },
                        { $set: { roi_status: "Completed" } }
                    );
                    continue;
                }

                // Determine investment date
                const investDateStr = member.roi_start_date || member.Date_of_joining || todayStr;
                if (!member.roi_start_date) {
                    await MemberModel.updateOne({ Member_id: member.Member_id }, { $set: { roi_start_date: investDateStr } });
                }
                const lastPayoutDateStr = member.roi_last_payout_date || null;

                // Calculate eligible dates to process (Catch-up logic)
                // Daily Incentive / ROI starts the NEXT DAY (tomorrow) after investment
                let dateCursor;
                if (!lastPayoutDateStr) {
                    dateCursor = moment(investDateStr, "YYYY-MM-DD").add(1, "days");
                } else {
                    dateCursor = moment(lastPayoutDateStr, "YYYY-MM-DD").add(1, "days");
                }

                const todayMoment = moment(todayStr, "YYYY-MM-DD");
                const daysToProcess = [];

                while (dateCursor.isSameOrBefore(todayMoment) && (currentCount + daysToProcess.length) < targetDays) {
                    daysToProcess.push(dateCursor.format("YYYY-MM-DD"));
                    dateCursor.add(1, "days");
                }

                if (daysToProcess.length === 0) {
                    continue;
                }

                // Dynamic daily payout based on level / schedule or default 0.50%
                let dailyTotalAmount = (member.roi_daily_amount && member.roi_daily_amount > 0)
                    ? Number(member.roi_daily_amount)
                    : Math.round(pkgAmount * 0.005 * 100) / 100;

                // Ensure total payout does not exceed 2x total target
                const totalTargetRoi = pkgAmount * 2;
                let currentPaid = Number(member.roi_total_paid) || 0;

                for (const payoutDate of daysToProcess) {
                    const remainingAllowed = Math.max(0, totalTargetRoi - currentPaid);
                    if (remainingAllowed <= 0) {
                        await MemberModel.updateOne(
                            { Member_id: member.Member_id },
                            { $set: { roi_status: "Completed" } }
                        );
                        break;
                    }

                    const actualDaily = Math.min(dailyTotalAmount, remainingAllowed);
                    const creditAmount = actualDaily;
                    const newCount = currentCount + 1;
                    const txId = `DI_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

                    const memberLevel = member.level !== undefined && member.level !== null ? member.level : 0;
                    const descText = memberLevel > 0
                        ? `Daily Incentive (Level ${memberLevel} - ₹${actualDaily}/day) - Day ${newCount}/${targetDays}`
                        : `Daily Incentive (0.50% of ₹${pkgAmount}) - Day ${newCount}/${targetDays}`;

                    // Create transaction with 100% Vendor Wallet (vw_credit)
                    const dailyTx = new TransactionModel({
                        transaction_id: txId,
                        transaction_date: payoutDate,
                        member_id: member.Member_id,
                        Name: member.Name,
                        mobileno: member.mobileno,
                        description: descText,
                        transaction_type: "Daily Incentive",
                        vw_credit: creditAmount.toString(),
                        ew_credit: "0",
                        tw_credit: "0",
                        ew_debit: "0",
                        tw_debit: "0",
                        gross_amount: actualDaily.toString(),
                        net_amount: actualDaily.toString(),
                        status: "Completed",
                        benefit_type: "Daily Incentive",
                        reference_no: `DI-P-${member.Member_id}-${newCount}`
                    });

                    await dailyTx.save();

                    currentCount = newCount;
                    currentPaid += creditAmount;
                    baseProcessedCount++;
                    processedCount++;

                    // Update Member vendor wallet balance and ROI status
                    const isNowCompleted = currentCount >= targetDays || currentPaid >= totalTargetRoi;
                    await MemberModel.updateOne(
                        { Member_id: member.Member_id },
                        {
                            $inc: {
                                vendor_wallet: creditAmount,
                                roi_total_paid: creditAmount
                            },
                            $set: {
                                roi_payout_count: currentCount,
                                roi_last_payout_date: payoutDate,
                                roi_status: isNowCompleted ? "Completed" : "Active"
                            }
                        }
                    );

                    console.log(`✅ [Daily Incentive] Credited Day ${newCount}/${targetDays} to ${member.Member_id} (Level ${memberLevel}): Total ₹${actualDaily} Credits`);
                }

            } catch (memberErr) {
                console.error(`❌ [Daily Incentive] Error processing primary ROI for member ${member.Member_id}:`, memberErr.message);
            }
        }

        // ─────────────────────────────────────────────────────────────
        // 2. PROCESS ADD-ON PACKAGES (Stored in AddOnPackageModel)
        // ─────────────────────────────────────────────────────────────
        const addonQuery = {
            amount: { $gt: 0 },
            roi_status: { $ne: "Completed" }
        };

        if (targetMemberId) {
            addonQuery.member_id = targetMemberId;
        }

        const activeAddons = await AddOnPackageModel.find(addonQuery);
        console.log(`🔍 [Daily Incentive] Found ${activeAddons.length} active add-on packages.`);

        for (const addon of activeAddons) {
            try {
                const pkgAmount = Number(addon.amount) || 0;
                if (pkgAmount <= 0) continue;

                const targetDays = addon.roi_payout_target || 200;
                let currentCount = addon.roi_payout_count || 0;

                if (currentCount >= targetDays) {
                    await AddOnPackageModel.updateOne(
                        { _id: addon._id },
                        { $set: { roi_status: "Completed" } }
                    );
                    continue;
                }

                const member = await MemberModel.findOne({ Member_id: addon.member_id });
                if (!member) continue;

                const investDateStr = addon.roi_start_date || (addon.createdAt ? moment(addon.createdAt).utcOffset("+05:30").format("YYYY-MM-DD") : todayStr);
                if (!addon.roi_start_date) {
                    await AddOnPackageModel.updateOne({ _id: addon._id }, { $set: { roi_start_date: investDateStr } });
                }
                const lastPayoutDateStr = addon.roi_last_payout_date || null;

                // Daily Incentive / ROI starts the NEXT DAY (tomorrow) after investment
                let dateCursor;
                if (!lastPayoutDateStr) {
                    dateCursor = moment(investDateStr, "YYYY-MM-DD").add(1, "days");
                } else {
                    dateCursor = moment(lastPayoutDateStr, "YYYY-MM-DD").add(1, "days");
                }

                const todayMoment = moment(todayStr, "YYYY-MM-DD");
                const daysToProcess = [];

                while (dateCursor.isSameOrBefore(todayMoment) && (currentCount + daysToProcess.length) < targetDays) {
                    daysToProcess.push(dateCursor.format("YYYY-MM-DD"));
                    dateCursor.add(1, "days");
                }

                if (daysToProcess.length === 0) {
                    continue;
                }

                const dailyTotalAmount = Math.round(pkgAmount * 0.005 * 100) / 100;
                const creditAmount = dailyTotalAmount;

                for (const payoutDate of daysToProcess) {
                    const newCount = currentCount + 1;
                    const txId = `DI_A_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

                    const dailyTx = new TransactionModel({
                        transaction_id: txId,
                        transaction_date: payoutDate,
                        member_id: addon.member_id,
                        Name: member.Name,
                        mobileno: member.mobileno,
                        description: `Daily Incentive (0.50% of ₹${pkgAmount} Add-on) - Day ${newCount}/${targetDays}`,
                        transaction_type: "Daily Incentive",
                        vw_credit: creditAmount.toString(),
                        ew_credit: "0",
                        tw_credit: "0",
                        ew_debit: "0",
                        tw_debit: "0",
                        gross_amount: dailyTotalAmount.toString(),
                        net_amount: dailyTotalAmount.toString(),
                        status: "Completed",
                        benefit_type: "Daily Incentive",
                        reference_no: `DI-A-${addon.package_id}-${newCount}`
                    });

                    await dailyTx.save();

                    currentCount = newCount;
                    addonProcessedCount++;
                    processedCount++;

                    const isNowCompleted = currentCount >= targetDays;

                    // Update AddOn Package record
                    await AddOnPackageModel.updateOne(
                        { _id: addon._id },
                        {
                            $set: {
                                roi_payout_count: currentCount,
                                roi_last_payout_date: payoutDate,
                                roi_status: isNowCompleted ? "Completed" : "Active"
                            }
                        }
                    );

                    // Credit Member vendor wallet
                    await MemberModel.updateOne(
                        { Member_id: addon.member_id },
                        {
                            $inc: {
                                vendor_wallet: creditAmount
                            }
                        }
                    );

                    console.log(`✅ [Daily Incentive] Credited Addon Day ${newCount}/${targetDays} to ${addon.member_id}: Total ₹${dailyTotalAmount} Credits`);
                }

            } catch (addonErr) {
                console.error(`❌ [Daily Incentive] Error processing addon ROI for ${addon.package_id}:`, addonErr.message);
            }
        }

        // ─────────────────────────────────────────────────────────────
        // 3. PROCESS 50-DAY LEVEL ROI SCHEDULES (Levels 1-7, Rank >= 3)
        // ─────────────────────────────────────────────────────────────
        const levelRoiQuery = {
            status: "Active",
            daily_amount: { $gt: 0 }
        };

        if (targetMemberId) {
            levelRoiQuery.sponsor_id = targetMemberId;
        }

        const activeSchedules = await LevelRoiScheduleModel.find(levelRoiQuery);
        console.log(`🔍 [Level Daily ROI] Found ${activeSchedules.length} active 50-day Level ROI schedules.`);

        for (const schedule of activeSchedules) {
            try {
                const targetDays = schedule.target_days || 50;
                let currentCount = schedule.payout_count || 0;

                if (currentCount >= targetDays) {
                    await LevelRoiScheduleModel.updateOne(
                        { schedule_id: schedule.schedule_id },
                        { $set: { status: "Completed" } }
                    );
                    continue;
                }

                // Check sponsor still exists and is active
                const sponsor = await MemberModel.findOne({
                    $or: [
                        { Member_id: schedule.sponsor_id },
                        { member_id: schedule.sponsor_id }
                    ]
                });

                if (!sponsor || String(sponsor.status || "").toLowerCase() !== "active") {
                    console.log(`⚠️ Sponsor ${schedule.sponsor_id} inactive or not found. Skipping schedule ${schedule.schedule_id}.`);
                    continue;
                }

                // Determine start date and next eligible dates (Daily starts the NEXT DAY after activation)
                const startDateStr = schedule.start_date || todayStr;
                const lastPayoutDateStr = schedule.last_payout_date || null;

                let dateCursor;
                if (!lastPayoutDateStr) {
                    dateCursor = moment(startDateStr, "YYYY-MM-DD").add(1, "days");
                } else {
                    dateCursor = moment(lastPayoutDateStr, "YYYY-MM-DD").add(1, "days");
                }

                const todayMoment = moment(todayStr, "YYYY-MM-DD");
                const daysToProcess = [];

                while (dateCursor.isSameOrBefore(todayMoment) && (currentCount + daysToProcess.length) < targetDays) {
                    daysToProcess.push(dateCursor.format("YYYY-MM-DD"));
                    dateCursor.add(1, "days");
                }

                if (daysToProcess.length === 0) {
                    continue;
                }

                const dailyAmount = Number(schedule.daily_amount) || 0;
                const totalTarget = Number(schedule.total_amount) || (dailyAmount * targetDays);
                let currentPaid = Number(schedule.total_paid) || 0;

                for (const payoutDate of daysToProcess) {
                    const remainingAllowed = Math.max(0, totalTarget - currentPaid);
                    if (remainingAllowed <= 0) {
                        await LevelRoiScheduleModel.updateOne(
                            { schedule_id: schedule.schedule_id },
                            { $set: { status: "Completed" } }
                        );
                        break;
                    }

                    const actualDaily = Math.min(dailyAmount, remainingAllowed);
                    const newCount = currentCount + 1;
                    const txId = `LROI_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

                    const descText = `Level ${schedule.level} Daily ROI (₹${actualDaily}/day) - Day ${newCount}/${targetDays} from Member ${schedule.from_member_id}`;

                    // 1. Create Transaction (vw_credit vendor wallet balance)
                    const levelRoiTx = new TransactionModel({
                        transaction_id: txId,
                        transaction_date: payoutDate,
                        member_id: schedule.sponsor_id,
                        Name: sponsor.Name || sponsor.name,
                        mobileno: sponsor.mobileno || sponsor.contactno,
                        description: descText,
                        transaction_type: "Level Daily ROI",
                        benefit_type: "Level ROI",
                        level: schedule.level,
                        related_member_id: schedule.from_member_id,
                        vw_credit: String(actualDaily),
                        ew_credit: "0",
                        ew_debit: "0",
                        net_amount: actualDaily,
                        gross_amount: actualDaily,
                        status: "Completed",
                        reference_no: schedule.schedule_id
                    });

                    // 2. Create Payout record
                    const payoutRecord = new PayoutModel({
                        payout_id: Date.now() + Math.floor(Math.random() * 1000),
                        date: moment(payoutDate, "YYYY-MM-DD").toDate(),
                        memberId: schedule.sponsor_id,
                        payout_type: `Level ${schedule.level} Daily ROI (50 Days)`,
                        ref_no: schedule.schedule_id,
                        amount: actualDaily,
                        count: newCount,
                        days: targetDays,
                        level: schedule.level,
                        sponsored_member_id: schedule.from_member_id,
                        sponsor_id: schedule.sponsor_id,
                        status: "Approved",
                        description: descText
                    });

                    await Promise.all([levelRoiTx.save(), payoutRecord.save()]);

                    // 3. Update Sponsor Vendor Wallet Balance
                    await MemberModel.updateOne(
                        { $or: [{ Member_id: schedule.sponsor_id }, { member_id: schedule.sponsor_id }] },
                        { $inc: { vendor_wallet: actualDaily } }
                    );

                    currentPaid += actualDaily;
                    currentCount = newCount;
                    levelRoiProcessedCount++;
                    processedCount++;

                    // 4. Update Schedule
                    const isScheduleDone = currentCount >= targetDays || currentPaid >= totalTarget;
                    await LevelRoiScheduleModel.updateOne(
                        { schedule_id: schedule.schedule_id },
                        {
                            $set: {
                                payout_count: currentCount,
                                total_paid: Math.round(currentPaid * 100) / 100,
                                last_payout_date: payoutDate,
                                status: isScheduleDone ? "Completed" : "Active"
                            }
                        }
                    );

                    console.log(`✅ [Level Daily ROI] Credited ₹${actualDaily} to ${schedule.sponsor_id} (Level ${schedule.level}, Day ${newCount}/${targetDays})`);

                    if (isScheduleDone) break;
                }
            } catch (scheduleErr) {
                console.error(`❌ [Level Daily ROI] Error processing schedule ${schedule.schedule_id}:`, scheduleErr.message);
            }
        }

        console.log(`🎉 [Daily Incentive] Completed processing: ${processedCount} payouts (${baseProcessedCount} primary, ${addonProcessedCount} addon, ${levelRoiProcessedCount} level ROI).`);

        return {
            success: true,
            baseProcessedCount,
            addonProcessedCount,
            levelRoiProcessedCount,
            processedCount,
            message: `Processed ${processedCount} Daily Incentive payouts successfully.`
        };

    } catch (globalErr) {
        console.error("❌ [Daily Incentive] Global ROI processing error:", globalErr.message);
        return { success: false, error: globalErr.message };
    } finally {
        isROIProcessing = false;
    }
};

/**
 * Process ROI for a single member on demand
 */
const processMemberROI = async (member) => {
    return processDailyROI(member.Member_id);
};

/**
 * Process ROI for a single Add-On package on demand
 */
const processAddOnROI = async (addon, member) => {
    return processDailyROI(member?.Member_id || addon.member_id);
};

module.exports = { processDailyROI, processMemberROI, processAddOnROI };
