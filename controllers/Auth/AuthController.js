const AdminModel = require("../../models/Admin/Admin");
const MemberModel = require("../../models/Users/Member");
const jwt = require("jsonwebtoken");
const {
  sendMail,
} = require("../../utils/EmailService");
const { generateOTP, storeOTP, verifyOTP } = require("../../utils/OtpService");
const admin = require("../../utils/FirebaseService");
const { generateMSCSEmail } = require("../../utils/generateMSCSEmail");
const { updateSponsorReferrals } = require("../../controllers/Users/mlmService/mlmService");
const { addMemberHierarchy } = require("../../utils/hierarchyHelper");
const path = require("path");
const fs = require("fs");

const recoverySubject = "BMS - Password Recovery";
const resetPasswordSubject = "BMS - OTP Verification";

const generateMemberCode = async () => {
  const members = await MemberModel.find({ member_code: { $exists: true, $ne: null } })
    .select("member_code")
    .lean();

  let maxCode = 100;
  for (const m of members) {
    const num = parseInt(m.member_code, 10);
    if (!isNaN(num) && num > maxCode) {
      maxCode = num;
    }
  }
  const nextCode = maxCode + 1;
  return String(nextCode).padStart(4, "0"); // "0101", "0102", "0103"...
};

const generateUniqueMemberId = async () => {
  let newNumber = 1;
  // Get the most recently created member (sorted by _id)
  const lastMember = await MemberModel.findOne().sort({ _id: -1 });

  if (lastMember && lastMember.Member_id) {
    const lastNumberStr = lastMember.Member_id.replace('BMS', '');
    const lastNumber = parseInt(lastNumberStr, 10);
    if (!isNaN(lastNumber) && lastNumber >= 1) {
      newNumber = lastNumber + 1;
    }
  }

  let finalId = String(newNumber).padStart(6, '0');

  // Guarantee uniqueness against both legacy BMS-prefixed IDs and new purely numeric IDs
  while (await MemberModel.exists({ Member_id: finalId }) || await MemberModel.exists({ Member_id: `BMS${String(newNumber).padStart(5, '0')}` })) {
    newNumber++;
    finalId = String(newNumber).padStart(6, '0');
  }
  return finalId;
};

const signup = async (req, res) => {
  try {
    const { email, password, Name, sponsorId, otp, ...otherDetails } = req.body;
    // const existingUser = await MemberModel.findOne({ email });
    // if (existingUser) {
    //   return res.status(400).json({ success: false, message: "Email already in use" });
    // }

    const mobileNumber = (otherDetails.mobileno || otherDetails.mobile || "").trim();
    // User ID is the mobile number
    const memberId = mobileNumber || await generateUniqueMemberId();
    const memberCode = await generateMemberCode();

    const existingMember = await MemberModel.findOne({
      $or: [
        { Member_id: memberId },
        ...(mobileNumber ? [{ mobileno: mobileNumber }] : [])
      ]
    });
    if (existingMember) {
      return res.status(400).json({ success: false, message: "Mobile number already registered." });
    }

    // Find the sponsor if provided
    let sponsor = null;
    const resolvedSponsorId = String(sponsorId || otherDetails.sponsor_id || otherDetails.Sponsor_code || otherDetails.introducer || "").trim();

    if (resolvedSponsorId) {
      if (resolvedSponsorId === memberId || (mobileNumber && resolvedSponsorId === mobileNumber)) {
        return res.status(400).json({ success: false, message: "You cannot sponsor yourself. Please enter a valid sponsor ID." });
      }

      sponsor = await MemberModel.findOne({
        $or: [
          { Member_id: resolvedSponsorId },
          { member_id: resolvedSponsorId },
          { mobileno: resolvedSponsorId },
          { member_code: resolvedSponsorId }
        ]
      });

      if (!sponsor) {
        const AgentModel = require("../../models/agent.model");
        const agent = await AgentModel.findOne({ agent_id: resolvedSponsorId });
        if (agent) {
          sponsor = {
            Member_id: agent.agent_id,
            Name: agent.name,
            status: agent.status || "active"
          };
        }
      }

      if (!sponsor) {
        return res.status(400).json({ success: false, message: "Invalid sponsor ID" });
      }
    }

    const finalSponsorId = sponsor ? (sponsor.Member_id || sponsor.member_id || resolvedSponsorId) : null;
    const finalSponsorName = sponsor ? (sponsor.Name || sponsor.name) : null;

    let memberData = {
      Member_id: memberId,
      member_id: memberId,
      member_code: memberCode,
      qr_code: `BMS-P2P:${memberId}`,
      email,
      emailid: email,
      password,
      Name,
      name: Name,
      mobileno: mobileNumber || memberId,
      contactno: mobileNumber || memberId,

      ...otherDetails,

      // Assign sponsor if provided (must override otherDetails)
      sponsor_id: finalSponsorId,
      Sponsor_code: finalSponsorId,
      Sponsor_name: finalSponsorName,

      introducer: finalSponsorId,
      introducer_name: finalSponsorName,

      status: "Pending",
      commission_eligible: true,
    };

    // Automatically build introducer hierarchy
    memberData = await addMemberHierarchy(memberData);

    const newMember = new MemberModel(memberData);
    await newMember.save();

    // If a sponsor was provided, add this member to the sponsor's direct referrals
    if (finalSponsorId && sponsor) {
      try {
        await updateSponsorReferrals(finalSponsorId, memberId);
        console.log(`✅ Added new member ${memberId} to sponsor ${finalSponsorId}'s direct referrals`);
      } catch (referralError) {
        console.error("Error updating sponsor referrals:", referralError);
      }
    }

    try {

      const { welcomeMessage, welcomeSubject } = generateMSCSEmail(memberId, password, Name);

      const textContent = `Dear ${Name}, Your account registration with E shopy has been completed. Member ID: ${memberId}, Password: ${password}. Your account is under verification process.`;

      const logoPath = path.join(__dirname, '../../utils/BMS.png');
      const fallbackLogoPath = path.join(__dirname, '../../utils/bms_logo.png');
      const resolvedLogoPath = fs.existsSync(logoPath) ? logoPath : (fs.existsSync(fallbackLogoPath) ? fallbackLogoPath : null);

      const attachments = resolvedLogoPath ? [{
        filename: path.basename(resolvedLogoPath),
        path: resolvedLogoPath,
        cid: 'bmslogo'
      }] : [];

      await sendMail(email, welcomeSubject, welcomeMessage, textContent, attachments);

    } catch (emailError) {
      console.error("Error sending welcome email:", emailError);
    }

    res.status(201).json({
      success: true,
      message: "Signup successful. Credentials sent to email.",
      user: {
        Member_id: newMember.Member_id,
        email: newMember.email,
        Name: newMember.Name
      },
    });

  } catch (error) {
    console.error("Signup Error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const getSponsorDetails = async (req, res) => {
  try {
    const { ref } = req.params;
    const cleanRef = String(ref || "").trim();

    let sponsor = await MemberModel.findOne({
      $or: [
        { Member_id: cleanRef },
        { member_id: cleanRef },
        { mobileno: cleanRef },
        { member_code: cleanRef }
      ]
    });

    if (!sponsor) {
      const AgentModel = require("../../models/agent.model");
      const agent = await AgentModel.findOne({ agent_id: cleanRef });
      if (agent) {
        return res.json({
          success: true,
          Member_id: agent.agent_id,
          name: agent.name,
          status: agent.status || "active",
        });
      }
      return res
        .status(404)
        .json({ success: false, message: "Invalid Sponsor Code" });
    }

    res.json({
      success: true,
      Member_id: sponsor.Member_id || sponsor.member_id,
      name: sponsor.Name || sponsor.name,
      status: sponsor.status || "Pending",
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const resetPassword = async (req, res) => {
  try {
    const { mobileno, password, otp } = req.body;

    if (!mobileno || !password || !otp) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    let searchPhone = mobileno;
    // Format the phone number since MongoDB stores it without +91 sometimes or with +91.
    // Try finding exact match, or match without +91, or match with +91
    let user = await MemberModel.findOne({
      $or: [
        { mobileno: searchPhone },
        { mobileno: searchPhone.replace('+91', '') },
        { mobileno: '+91' + searchPhone.replace('+91', '') }
      ]
    });

    if (!user) {
      return res.status(404).json({ success: false, message: "Mobile number not registered" });
    }

    try {
      // Verify Firebase token
      const decodedToken = await admin.auth().verifyIdToken(otp);
      const phoneVerified = decodedToken.phone_number;

      let memberPhone = String(user.mobileno).trim().replace(/\s+/g, '');
      if (!memberPhone.startsWith('+')) {
        memberPhone = '+91' + memberPhone;
      }

      // Also format the phoneVerified to remove +91 for comparison if needed
      let formattedVerifiedPhone = phoneVerified;

      if (formattedVerifiedPhone !== memberPhone) {
        return res.status(400).json({ success: false, message: "Phone number mismatch. Please use your registered mobile number." });
      }

      // Reset password
      user.password = password;
      await user.save();

      return res.json({
        success: true,
        message: "Password reset successfully",
      });
    } catch (firebaseError) {
      console.error("Firebase Verification Error:", firebaseError);
      return res.status(400).json({ success: false, message: "Invalid or expired Firebase token." });
    }
  } catch (error) {
    console.error("Error in resetPassword:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const login = async (req, res) => {
  try {
    const { username, password } = req.body;
    const cleanUsername = (username || "").trim();

    // Find member by mobile number or Member_id
    let user = await MemberModel.findOne({
      $or: [
        { mobileno: cleanUsername },
        { Member_id: cleanUsername }
      ]
    });
    
    // Legacy support: if the username is purely numeric (e.g. 000001), also check if they exist as BMS00001
    if (!user && /^\d+$/.test(cleanUsername)) {
      const legacyUsername = `BMS${parseInt(cleanUsername, 10).toString().padStart(5, '0')}`;
      user = await MemberModel.findOne({ Member_id: legacyUsername });
    }
    
    const admin = await AdminModel.findOne({ username: cleanUsername });
    const foundUser = user || admin;
    if (!foundUser) {
      return res
        .status(404)
        .json({ success: false, message: "User or Admin not found" });
    }
    const userRole = user instanceof MemberModel ? "USER" : (admin.role || "ADMIN");
    let isPasswordValid = password === (foundUser.PASSWORD || foundUser.password);
    
    if (!isPasswordValid) {
      return res
        .status(401)
        .json({ success: false, message: "Entered wrong password. Please try again." });
    }

    const jwtSecret = process.env.JWT_SECRET || "blusky_microservices_secure_jwt_secret_key_2026";
    const token = jwt.sign(
      {
        id: foundUser._id,
        role: userRole,
        memberId: foundUser?.Member_id ?? null,
      },
      jwtSecret,
      { expiresIn: "24h" }
    );
    return res.status(200).json({

      success: true,
      role: userRole,
      user: foundUser,
      token,
      message: `${userRole.charAt(0).toUpperCase() + userRole.slice(1).toLowerCase()
        } login successful`,

    });

  } catch (error) {
    console.error("Login Error:", error);
    return res
      .status(500)
      .json({ success: false, message: error });
  }
};

const impersonate = async (req, res) => {
  try {
    const { memberId } = req.body;
    if (!memberId) {
      return res.status(400).json({ success: false, message: "Member ID is required" });
    }

    const member = await MemberModel.findOne({ Member_id: memberId });
    if (!member) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }

    const jwtSecret = process.env.JWT_SECRET || "blusky_microservices_secure_jwt_secret_key_2026";
    const token = jwt.sign(
      {
        id: member._id,
        role: "USER",
        memberId: member.Member_id,
      },
      jwtSecret,
      { expiresIn: "2h" } // Short lived token for impersonation
    );

    return res.status(200).json({
      success: true,
      token,
      message: `Impersonation token generated for ${member.Name}`,
    });
  } catch (error) {
    console.error("Impersonation Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const sendRegistrationOTP = async (req, res) => {
  try {
    const { mobileno } = req.body;
    const cleanMobile = String(mobileno || "").replace(/\D/g, "").slice(0, 10);
    if (!cleanMobile || cleanMobile.length !== 10) {
      return res.status(400).json({ success: false, message: "Please enter a valid 10-digit mobile number." });
    }

    const existing = await MemberModel.findOne({
      $or: [
        { Member_id: cleanMobile },
        { mobileno: cleanMobile }
      ]
    });
    if (existing) {
      return res.status(400).json({ success: false, message: "This mobile number is already registered. Please login instead." });
    }

    const otp = generateOTP(6);
    storeOTP(cleanMobile, otp);

    console.log(`📱 [REGISTRATION OTP] Mobile: ${cleanMobile} -> OTP: ${otp}`);

    return res.status(200).json({
      success: true,
      message: `OTP sent successfully to +91 ${cleanMobile}`,
      devOtp: otp,
    });
  } catch (error) {
    console.error("sendRegistrationOTP error:", error);
    return res.status(500).json({ success: false, message: "Failed to send OTP", error: error.message });
  }
};

const verifyRegistrationOTP = async (req, res) => {
  try {
    const { mobileno, otp } = req.body;
    const cleanMobile = String(mobileno || "").replace(/\D/g, "").slice(0, 10);

    const isValid = verifyOTP(cleanMobile, String(otp || "").trim());
    if (!isValid) {
      return res.status(400).json({ success: false, message: "Invalid or expired OTP. Please try again." });
    }

    const jwtSecret = process.env.JWT_SECRET || "blusky_microservices_secure_jwt_secret_key_2026";
    const token = jwt.sign(
      { mobile: cleanMobile, verified: true },
      jwtSecret,
      { expiresIn: "15m" }
    );

    return res.status(200).json({
      success: true,
      message: "Mobile number verified successfully!",
      token
    });
  } catch (error) {
    console.error("verifyRegistrationOTP error:", error);
    return res.status(500).json({ success: false, message: "Verification failed", error: error.message });
  }
};

module.exports = {
  signup,
  getSponsorDetails,
  resetPassword,
  login,
  impersonate,
  sendRegistrationOTP,
  verifyRegistrationOTP,
};
