const MemberModel = require("../../../models/Users/Member");

const getSponsers = async (req, res) => {
  try {
    const { memberId } = req.params

    if (!memberId) {
      return res.status(400).json({ success: false, message: "Member ID is required" });
    }
    const numericPart = parseInt(memberId.replace('BMS', ''), 10);
    const pad5 = !isNaN(numericPart) ? String(numericPart).padStart(5, '0') : memberId;
    const pad6 = !isNaN(numericPart) ? String(numericPart).padStart(6, '0') : memberId;
    const possibleIds = !isNaN(numericPart) 
      ? [memberId, memberId.replace('BMS', ''), `BMS${pad5}`, `BMS${pad6}`, pad5, pad6, `BMS${numericPart}`]
      : [memberId];

    const parentUser = await MemberModel.findOne({
      $or: [{ Member_id: { $in: possibleIds } }, { member_id: { $in: possibleIds } }]
    });

    if (!parentUser) {
      return res.status(404).json({ success: false, message: "Parent user not found" });
    }

    // Try to match against any of the possible IDs of the parent
    // Also include the parentUser's actual ID, member_code, and mobileno just in case
    const allPossibleSponsorIds = [...new Set([...possibleIds, parentUser.Member_id, parentUser.member_id, parentUser.member_code, parentUser.mobileno])].filter(Boolean);

    const sponsoredUsers = await MemberModel.aggregate([
      { 
        $match: { 
          $or: [
            { Sponsor_code: { $in: allPossibleSponsorIds } },
            { sponsor_id: { $in: allPossibleSponsorIds } },
            { introducer: { $in: allPossibleSponsorIds } }
          ]
        } 
      },
{
        $project: {
    _id: 0,
      Member_id: { $ifNull: ["$Member_id", "$member_id"] },
    Name: { $ifNull: ["$Name", "$name"] },
    status: 1,
      Date_of_joining: 1,
        profile_image: { $ifNull: ["$profile_image", "$member_image"] },
    mobileno: { $ifNull: ["$mobileno", "$contactno"] },
    Sponsor_code: { $ifNull: ["$Sponsor_code", "$sponsor_id", "$introducer"] },
    Sponsor_name: { $ifNull: ["$Sponsor_name", "$introducer_name"] },
    wallet_balance: 1,
      total_team: 1,
        direct_referrals: 1
  }
}
    ]);

    let actualSponsor = null;
    if (parentUser.Sponsor_code || parentUser.sponsor_id || parentUser.introducer) {
      const spId = parentUser.Sponsor_code || parentUser.sponsor_id || parentUser.introducer;
      // Also try appending/stripping BMS
      const numericSp = parseInt(spId.replace('BMS', ''), 10);
      const possibleSpIds = !isNaN(numericSp) 
        ? [spId, spId.replace('BMS', ''), `BMS${String(numericSp).padStart(5, '0')}`, `BMS${String(numericSp).padStart(6, '0')}`, String(numericSp).padStart(5, '0'), String(numericSp).padStart(6, '0')]
        : [spId];
        
      actualSponsor = await MemberModel.findOne(
        { $or: [{ Member_id: { $in: possibleSpIds } }, { member_id: { $in: possibleSpIds } }] },
        { 
          _id: 0, 
          Member_id: 1, member_id: 1,
          Name: 1, name: 1,
          status: 1,
          profile_image: 1, member_image: 1,
          mobileno: 1, contactno: 1
        }
      );
    }

res.json({ success: true, parentUser, sponsoredUsers, actualSponsor });
  } catch (error) {
  res.status(500).json({ error: 'Server error' });
}
};


const checkSponsorReward = async (req, res) => {
  try {
    const { memberId } = req.params;

    if (!memberId) {
      return res.status(400).json({ success: false, message: "Member ID is required" });
    }

    // 🔍 Find member by Member_id
    const member = await MemberModel.findOne({ Member_id: memberId });

    if (!member) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }

    // ✅ Check member’s own package
    const hasRequiredPackage =
      (member.spackage === "RD" || member.spackage === "RD_1200" || member.spackage === "RD_600") &&
      (member.package_value === 1200 || member.package_value === 600);

    // ✅ Count how many members this person has sponsored
    const sponsoredCount = await MemberModel.countDocuments({ Sponsor_code: memberId });

    // ✅ Eligibility: correct package + at least 2 sponsored members
    const isEligibleForReward = hasRequiredPackage && sponsoredCount >= 2;

    let message = "";
    if (!hasRequiredPackage) {
      message = `❌ ${member.Name} does not have the required package (standerd - ₹2600).`;
    } else if (sponsoredCount < 2) {
      message = `⚠️ ${member.Name} has the correct package but needs ${2 - sponsoredCount} more sponsored member(s) to qualify.`;
    } else {
      message = `🎉 Congratulations ${member.Name}! You have the correct package and ${sponsoredCount} sponsored members — you are eligible for the reward!`;
    }

    res.json({
      success: true,
      memberId: member.Member_id,
      memberName: member.Name,
      spackage: member.spackage,
      package_value: member.package_value,
      sponsoredCount,
      isEligibleForReward,
      message,
    });
  } catch (error) {
    console.error("Error in checkSponsorReward:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
};


module.exports = { getSponsers, checkSponsorReward };

