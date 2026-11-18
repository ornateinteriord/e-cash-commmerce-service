const mongoose = require("mongoose");
const MemberModel = require("../../../models/Users/Member");
const jwt = require("jsonwebtoken");

// Submit KYC details
exports.submitKYC = async (req, res) => {
  try {
    const {
      ref_no,
      member_id,
      Member_id,
      memberId,
      userId,
      bankAccount,
      account_number,
      ifsc,
      ifsc_code,
      pan,
      Pan_no,
      aadhar_no,
      address,
      bankName,
      bank_name,
      panImage,
      pan_image,
      aadhaarImage,
      aadhaar_image,
      checkImage,
      passbookImage,
      rationCardImage,
      profileImage,
      profile_image,
      upiId,
      upi_id,
      accountName,
      account_name
    } = req.body;

    // Resolve member identification from body, req.user, or JWT token header
    let targetMemberId = ref_no || Member_id || member_id || memberId || userId || req.user?.memberId || req.user?.Member_id || req.user?.id;

    if (!targetMemberId && req.headers.authorization) {
      try {
        const token = req.headers.authorization.split(" ")[1];
        if (token) {
          const jwtSecret = process.env.JWT_SECRET || "blusky_microservices_secure_jwt_secret_key_2026";
          const decoded = jwt.verify(token, jwtSecret);
          targetMemberId = decoded.memberId || decoded.id || decoded.Member_id;
        }
      } catch (tokenErr) {
        console.warn("[KYC] Could not decode authorization token:", tokenErr.message);
      }
    }

    if (!targetMemberId) {
      return res.status(400).json({ message: "Member identifier (ref_no / Member_id / memberId) is required" });
    }

    const orConditions = [
      { Member_id: targetMemberId },
      { member_id: targetMemberId },
      { mobileno: targetMemberId },
      { contactno: targetMemberId },
      { member_code: targetMemberId }
    ];
    if (mongoose.Types.ObjectId.isValid(targetMemberId)) {
      orConditions.unshift({ _id: targetMemberId });
    }

    // Find the member flexibly
    let member = await MemberModel.findOne({ $or: orConditions });

    if (!member && mongoose.Types.ObjectId.isValid(targetMemberId)) {
      member = await MemberModel.findById(targetMemberId);
    }

    if (!member) {
      return res.status(404).json({ message: "Member not found" });
    }

    const finalPanImage = panImage || pan_image;
    const finalAadhaarImage = aadhaarImage || aadhaar_image;
    const finalProfileImage = profileImage || profile_image || req.body.member_image;
    const finalAccount = bankAccount || account_number;
    const finalIfsc = ifsc || ifsc_code;
    const finalBankName = bankName || bank_name;
    const finalUpi = upiId || upi_id;
    const finalAccountName = accountName || account_name;
    const finalPan = pan || Pan_no || req.body.pan_no || req.body.panNo;
    const finalAadhaar = aadhar_no || req.body.aadharcard_no || req.body.aadhaar_no || req.body.aadhaar || req.body.adhaar;

    // Validate that required documents are provided (Profile image is optional)
    const missingDocuments = [];
    if (!finalPanImage && !finalAadhaarImage) missingDocuments.push("PAN / Aadhaar Image");

    if (missingDocuments.length > 0) {
      return res.status(400).json({
        message: `Missing required fields/documents: ${missingDocuments.join(", ")}`
      });
    }

    // ==================== CASHFREE BANK VERIFICATION ====================
    // Note: Currently commented out - Admin will manually validate bank details
    // Uncomment this section when Cashfree Payout is activated

    /* 
    const axios = require("axios");
    
    try {
      // First, authenticate with Cashfree to get Bearer token
      const authResponse = await axios.post(
        "https://payout-gamma.cashfree.com/payout/v1/authorize",
        {},
        {
          headers: {
            "X-Client-Id": process.env.CI_APP_ID,
            "X-Client-Secret": process.env.CI_SECRET_KEY,
            "Content-Type": "application/json",
          }
        }
      );

      // Log the auth response for debugging
      console.log("Auth Response:", authResponse.data);

      // Extract token from response
      const bearerToken = authResponse.data?.data?.token || authResponse.data?.token;

      if (!bearerToken) {
        console.error("Failed to extract token from auth response:", authResponse.data);
        throw new Error("Failed to get authorization token from Cashfree");
      }

      console.log("Bearer Token:", bearerToken);

      // Validate bank details using GET request with query parameters
      // This is the correct way to validate bank details in Cashfree
      console.log("Making bank validation request with params:", {
        name: member.Name,
        bankAccount: bankAccount,
        ifsc: ifsc
      });

      const validationResponse = await axios.get(
        "https://payout-gamma.cashfree.com/payout/v1/validation/bankDetails",
        {
          params: {
            name: member.Name,
            bankAccount: bankAccount,
            ifsc: ifsc
          },
          headers: {
            "Authorization": `Bearer ${bearerToken}`,
            "Content-Type": "application/json",
          }
        }
      );

      // Log the validation response for debugging
      console.log("Validation Response:", validationResponse.data);

      // Check if bank validation was successful
      if (validationResponse.data.status !== "SUCCESS") {
        return res.status(400).json({
          message: "Bank account verification failed",
          details: validationResponse.data.message || "Invalid bank details provided"
        });
      }

      // Log successful validation
      console.log("Bank account verified successfully for member:", ref_no);
    } catch (validationError) {
      console.error("Bank validation error:", validationError.response?.data || validationError.message);
      return res.status(400).json({
        message: "Bank account verification failed",
        details: validationError.response?.data?.message || "Could not verify bank details with payment provider"
      });
    }
    */

    // ==================== END CASHFREE VERIFICATION ====================

    // Update member with KYC details
    if (finalAccount) member.account_number = finalAccount;
    if (finalIfsc) member.ifsc_code = finalIfsc;
    if (finalBankName) member.bank_name = finalBankName;
    if (finalUpi) member.upi_id = finalUpi;
    if (finalAccountName) member.accountName = finalAccountName;
    if (finalPan) {
      member.Pan_no = finalPan;
      member.pan_no = finalPan;
    }
    if (finalAadhaar) member.aadharcard_no = finalAadhaar;
    if (address) member.address = address;
    member.kycStatus = "PROCESSING";

    // Update document URLs
    if (finalPanImage) member.panImage = finalPanImage;
    if (finalAadhaarImage) member.aadhaarImage = finalAadhaarImage;
    if (checkImage) member.checkImage = checkImage;
    if (passbookImage) member.passbookImage = passbookImage;
    if (rationCardImage) member.rationCardImage = rationCardImage;
    if (finalProfileImage) {
      member.profile_image = finalProfileImage;
      member.profileImage = finalProfileImage;
    }

    // Save the updated member
    await member.save();

    res.json({
      success: true,
      message: "KYC submitted successfully with verified bank details",
      data: {
        accountName: member.accountName || member.Name,
        account_number: member.account_number,
        ifsc_code: member.ifsc_code,
        bank_name: member.bank_name,
        upi_id: member.upi_id,
        Pan_no: member.Pan_no || member.pan_no,
        aadharcard_no: member.aadharcard_no,
        panImage: member.panImage,
        profileImage: member.profile_image || member.profileImage,
        kycStatus: member.kycStatus
      }
    });
  } catch (error) {
    console.error("Error submitting KYC:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Approve KYC
exports.approveKYC = async (req, res) => {
  try {
    const { ref_no, memberId } = req.body;
    const targetRef = ref_no || memberId;

    // Find the member by ref_no / Member_id / mobile
    const member = await MemberModel.findOne({
      $or: [
        { Member_id: targetRef },
        { member_id: targetRef },
        { mobileno: targetRef },
        { contactno: targetRef },
        { member_code: targetRef },
        ...(mongoose.Types.ObjectId.isValid(targetRef) ? [{ _id: targetRef }] : [])
      ]
    });

    if (!member) {
      return res.status(404).json({ message: "Member not found" });
    }

    // Update KYC status to APPROVED
    member.kycStatus = "APPROVED";
    await member.save();

    // Trigger auto beneficiary creation
    await autoCreateBeneficiary(member);

    res.json({ message: "KYC approved & beneficiary creation initiated" });
  } catch (error) {
    console.error("Error approving KYC:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Get KYC submissions (support filter by status: PENDING, PROCESSING, APPROVED, REJECTED, or ALL)
exports.getKycSubmissions = async (req, res) => {
  try {
    const { status, q, page = 1, limit = 50 } = req.query;

    let filter = {};
    if (status && status !== "ALL") {
      filter.kycStatus = { $regex: new RegExp(`^${status}$`, "i") };
    } else {
      // By default or for ALL pending review, show submissions awaiting action or all submitted
      filter.kycStatus = status === "ALL" 
        ? { $in: ["PROCESSING", "PENDING", "APPROVED", "REJECTED"] }
        : { $in: ["PROCESSING", "PENDING"] };
    }

    // 🔍 Search filter
    if (q) {
      filter.$or = [
        { Member_id: q },
        { Name: { $regex: q, $options: "i" } },
        { email: { $regex: q, $options: "i" } },
        { mobileno: { $regex: q, $options: "i" } }
      ];
    }

    const skip = (Math.max(parseInt(page, 10), 1) - 1) * parseInt(limit, 10);

    const submissions = await MemberModel.find(filter)
      .select("Member_id Name mobileno email account_number ifsc_code bank_name Pan_no kycStatus beneficiaryStatus beneficiaryId address panImage aadhaarImage checkImage passbookImage rationCardImage profile_image createdAt updatedAt")
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10));

    const total = await MemberModel.countDocuments(filter);

    res.json({
      total,
      count: submissions.length,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      data: submissions
    });
  } catch (error) {
    console.error("Error fetching KYC submissions:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Get specific member KYC details (fast & lightweight single query)
exports.getMemberKycDetails = async (req, res) => {
  try {
    const targetRef = req.params.memberId || req.query.memberId || req.user?.memberId || req.user?.Member_id || req.user?.id;
    if (!targetRef) {
      return res.status(400).json({ success: false, message: "Member identifier is required" });
    }

    const orConditions = [
      { Member_id: targetRef },
      { member_id: targetRef },
      { mobileno: targetRef },
      { contactno: targetRef },
      { member_code: targetRef }
    ];
    if (mongoose.Types.ObjectId.isValid(targetRef)) {
      orConditions.unshift({ _id: targetRef });
    }

    const member = await MemberModel.findOne({ $or: orConditions })
      .select("Member_id Name name accountName account_number ifsc_code bank_name upi_id Pan_no pan_no aadharcard_no panImage aadhaarImage profile_image profileImage member_image kycStatus beneficiaryStatus beneficiaryId address");

    if (!member) {
      return res.status(404).json({ success: false, message: "Member not found" });
    }

    const kycDetails = {
      accountName: member.accountName || member.Name || member.name || '',
      account_number: member.account_number || '',
      ifsc_code: member.ifsc_code || '',
      bank_name: member.bank_name || '',
      upi_id: member.upi_id || '',
      Pan_no: member.Pan_no || member.pan_no || '',
      pan_no: member.pan_no || member.Pan_no || '',
      aadharcard_no: member.aadharcard_no || '',
      panImage: member.panImage || null,
      aadhaarImage: member.aadhaarImage || null,
      profileImage: member.profile_image || member.profileImage || member.member_image || null,
      kycStatus: member.kycStatus || 'PENDING',
      beneficiaryStatus: member.beneficiaryStatus || 'NOT_CREATED',
      beneficiaryId: member.beneficiaryId || '',
      address: member.address || ''
    };

    res.json({
      success: true,
      data: {
        ...member.toObject(),
        kyc_details: kycDetails
      }
    });
  } catch (error) {
    console.error("Error fetching member KYC details:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};


// Auto create beneficiary in Cashfree
async function autoCreateBeneficiary(user) {
  // If beneficiary is already created, return
  if (user.beneficiaryStatus === "CREATED") return;

  try {
    // Import axios here to avoid issues with module loading
    const axios = require("axios");

    // First, authenticate with Cashfree to get Bearer token
    const authResponse = await axios.post(
      "https://payout-gamma.cashfree.com/payout/v1/authorize"
      ,
      {},
      {
        headers: {
          "x-client-id": process.env.CI_APP_ID,
          "x-client-secret": process.env.CI_SECRET_KEY,
          "Content-Type": "application/json",
        }

      }
    );
    console.log("Cashfree Auth Responseqqqqq:", authResponse.data);

    // Extract token from response - handle both possible response structures
    const bearerToken = authResponse.data?.data?.token || authResponse.data?.token;

    if (!bearerToken) {
      throw new Error(`Failed to extract authorization token from Cashfree. Response: ${JSON.stringify(authResponse.data)}`);
    }

    // Generate beneficiary ID
    const beneficiaryId = `BEN_${user.Member_id}`;

    // Prepare payload for Cashfree API (use `beneId` as required by Cashfree)
    const payload = {
      beneId: beneficiaryId,
      name: user.Name,
      email: user.email,
      phone: user.mobileno,
      bankAccount: user.account_number,
      ifsc: user.ifsc_code,
      address1: user.address || "India"
    };

    // Make API call to Cashfree with Bearer token
    const response = await axios.post(
      "https://payout-gamma.cashfree.com/payout/v1/addBeneficiary"
      ,
      payload,
      {
        headers: {
          "Authorization": `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
        }
      }
    );

    // If successful, update user with beneficiary ID
    if (response.data.status === "SUCCESS") {
      user.beneficiaryId = beneficiaryId;
      user.beneficiaryStatus = "CREATED";
      user.bank_details = "Beneficiary successfully added and updated in Cashfree";
      await user.save();
      console.log(`Beneficiary created successfully for user ${user.Member_id}`);
    } else {
      console.error(`Failed to create beneficiary for user ${user.Member_id}:`, response.data);
      user.bank_details = `Failed to create beneficiary: ${response.data.message || 'Unknown error'}`;
      await user.save();
    }
  } catch (error) {
    console.error(`Error creating beneficiary for user ${user.Member_id}:`, error.response?.data || error.message);
  }
}

// Export the autoCreateBeneficiary function for use in other modules
exports.autoCreateBeneficiary = autoCreateBeneficiary;