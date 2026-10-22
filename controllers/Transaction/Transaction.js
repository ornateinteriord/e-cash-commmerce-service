const mongoose = require("mongoose");
const TransactionModel = require("../../models/Transaction/Transaction");

const getTransactionDetails = async (req, res) => {
  try {
    const loggedInMemberId = req.user.memberId;
    const userRole = req.user.role;
    const { status, type } = req.query;

    let query = {};
    if (loggedInMemberId) {
      const numericPart = parseInt(loggedInMemberId.replace('BMS', ''), 10);
      const pad5 = String(numericPart).padStart(5, '0');
      const pad6 = String(numericPart).padStart(6, '0');
      const possibleIds = [loggedInMemberId, loggedInMemberId.replace('BMS', ''), `BMS${pad5}`, `BMS${pad6}`, pad5, pad6, `BMS${numericPart}`];
      
      if (userRole === "ADMIN") {
        query = { member_id: { $in: possibleIds } };
      } else if (userRole === "USER") {
        query = { member_id: { $in: possibleIds } };
      }
    }
    if (status && status !== "all") {
      query.status = status;
    }

    if (type && type !== "all") {
      if (type.toLowerCase() === "withdrawal") {
        query.transaction_type = "Withdrawal";
      } else if (type.toLowerCase() === "credits" || type.toLowerCase() === "credit") {
        query.$and = [
          {
            $or: [
              { ew_credit: { $nin: ["0", "0.00", 0, null, ""] } },
              { ew_debit: { $nin: ["0", "0.00", 0, null, ""] } },
              {
                transaction_type: {
                  $regex: /credit|deposit|load|withdraw|activat|package|daily|incentive|single|level|referral|direct|p2p|transfer|commission|benefit|roi/i
                }
              },
              {
                description: {
                  $regex: /credit|deposit|load|withdraw|activat|package|daily|incentive|single|level|referral|direct|p2p|transfer|commission|benefit|roi/i
                }
              }
            ]
          },
          { transaction_type: { $not: /^loan/i } }
        ];
      } else if (type.toLowerCase() === "topup" || type.toLowerCase() === "retopup" || type.toLowerCase() === "re-topup") {
        query.$or = [
          { tw_credit: { $nin: ["0", "0.00", 0, null, ""] } },
          { tw_debit: { $nin: ["0", "0.00", 0, null, ""] } },
          { transaction_type: { $regex: /top\s*up|re-?\s*top\s*up|re-?\s*invest/i } },
          { description: { $regex: /top\s*up|re-?\s*top\s*up|re-?\s*invest|50%\s*re-?topup/i } }
        ];
      } else {
        query.account_type = type;
      }
    }

    const transactions = await TransactionModel.aggregate([
      { $match: query },
      {
        $addFields: {
          extracted_related_id: {
            $cond: {
              if: { $and: [
                { $ne: ["$description", null] },
                { $regexMatch: { input: { $ifNull: ["$description", ""] }, regex: /from U\w+/i } }
              ]},
              then: {
                $trim: { input: { $arrayElemAt: [{ $split: ["$description", "from "] }, 1] } }
              },
              else: "$related_member_id"
            }
          }
        }
      },
      {
        $lookup: {
          from: "vendor_tbl",
          localField: "extracted_related_id",
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
          },
          related_member_id: {
            $ifNull: [
              "$related_member_id",
              "$extracted_related_id"
            ]
          }
        }
      },
      {
        $project: {
          related_member: 0,
          extracted_related_id: 0
        }
      },
      { $sort: { createdAt: -1 } } // Sort by date descending
    ]);

    if (!transactions.length) {
      return res.status(200).json({ 
        success: true, 
        message: `No ${status && status !== 'all' ? status + ' ' : ''}transactions found`,
        data: []
      });
    }

    // Check if today is Saturday
    const today = new Date();
    const dayOfWeek = true; 
    const isSaturday = true;
    
    // Check if user already made a repayment today
    const todayStart = new Date(today);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(today);
    todayEnd.setHours(23, 59, 59, 999);

    const existingRepaymentToday = await TransactionModel.findOne({
      member_id: loggedInMemberId,
      transaction_type: 'Loan Repayment',
      createdAt: {
        $gte: todayStart,
        $lte: todayEnd
      }
    });

    // Repay is enabled only on Saturday AND if no repayment was made today
    const isRepayEnabled = isSaturday && !existingRepaymentToday;

    // Get day names for additional info
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const currentDayName = dayNames[dayOfWeek];
    const enabledDays = "Saturday";

    return res.status(200).json({ 
      success: true, 
      data: transactions,
      filter: status || 'all',
      repayConfig: {
        isEnabled: isRepayEnabled,
        enabledDays: enabledDays,
        currentDay: currentDayName,
        message: isRepayEnabled 
          ? `Repayment is available today (${currentDayName})` 
          : `Repayment is only available on ${enabledDays}`
      },
      isRepayEnabled: isRepayEnabled,
      alreadyRepaidToday: !!existingRepaymentToday
    });
  } catch (error) {
    console.error("Error fetching transaction details:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

module.exports = getTransactionDetails;

    // const today = new Date();
    // const dayOfWeek = today.getDay(); 
    // const isSaturday = true;
    // const isRepayEnabled = true;
   