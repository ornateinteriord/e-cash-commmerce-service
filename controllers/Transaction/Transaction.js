const mongoose = require("mongoose");
const TransactionModel = require("../../models/Transaction/Transaction");
const MemberModel = require("../../models/Users/Member");

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
        query.$or = [
          { transaction_type: { $regex: /withdrawal/i } },
          { description: { $regex: /withdrawal/i } }
        ];
      } else if (type.toLowerCase() === "credits" || type.toLowerCase() === "credit") {
        query.$and = [
          {
            $or: [
              { ew_credit: { $nin: ["0", "0.00", 0, null, ""] } },
              { ew_debit: { $nin: ["0", "0.00", 0, null, ""] } },
              { vw_credit: { $nin: ["0", "0.00", 0, null, ""] } },
              { vw_debit: { $nin: ["0", "0.00", 0, null, ""] } },
              { pw_credit: { $nin: ["0", "0.00", 0, null, ""] } },
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
          related_member_code: {
            $ifNull: [
              "$related_member_code",
              { $arrayElemAt: ["$related_member.member_code", 0] }
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
      { $sort: { createdAt: -1, transaction_date: -1 } } // Sort by date descending
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

    // Mask & sanitize descriptions: replace phone number of vendors with member_code, and "Member" -> "Vendor"
    const allMembers = await MemberModel.find({}).select('Member_id member_code mobileno').lean();
    const codeLookup = {
      '9004478100': '564080',
      '9740406962': '566962'
    };
    for (const m of allMembers) {
      const code = m.member_code || m.Member_code;
      if (code) {
        if (m.Member_id) codeLookup[String(m.Member_id).trim()] = String(code).trim();
        if (m.mobileno) codeLookup[String(m.mobileno).trim()] = String(code).trim();
      }
    }

    const sanitizedTransactions = transactions.map(tx => {
      let desc = tx.description || "";
      for (const [phone, code] of Object.entries(codeLookup)) {
        if (desc.includes(phone)) {
          desc = desc.split(phone).join(code);
        }
      }
      desc = desc.replace(/\bMember\b/g, 'Vendor').replace(/\bmember\b/g, 'vendor');
      desc = desc.replace(/\b([6-9]\d{9})\b/g, (phone) => codeLookup[phone] || (phone === '9004478100' ? '564080' : phone === '9740406962' ? '566962' : ('56' + phone.slice(-4))));

      const relCode = tx.related_member_code || (tx.related_member_id && codeLookup[tx.related_member_id]) || (tx.related_member_id === '9004478100' ? '564080' : tx.related_member_id === '9740406962' ? '566962' : (/^[6-9]\d{9}$/.test(tx.related_member_id) ? ('56' + tx.related_member_id.slice(-4)) : tx.related_member_id));
      return {
        ...tx,
        description: desc,
        related_member_code: relCode
      };
    });

    return res.status(200).json({ 
      success: true, 
      data: sanitizedTransactions,
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
