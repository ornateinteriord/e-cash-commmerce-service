const express = require("express");
const jwt = require("jsonwebtoken");
const { submitKYC, approveKYC, getKycSubmissions, getMemberKycDetails } = require("../controllers/Users/KYC/kycController");
const { initiatePayout, getBeneficiaryStatus } = require("../controllers/Users/KYC/payoutController");
const router = express.Router();

// Optional auth middleware: extracts user from Bearer token if provided
const optionalAuth = (req, res, next) => {
  const auth = req.headers["authorization"] || req.headers["Authorization"];
  if (auth && auth.startsWith("Bearer")) {
    try {
      const token = auth.split(" ")[1];
      const jwtSecret = process.env.JWT_SECRET || "blusky_microservices_secure_jwt_secret_key_2026";
      req.user = jwt.verify(token, jwtSecret);
    } catch (err) {
      // Token invalid or expired - proceed to allow body ref_no lookup
    }
  }
  next();
};

// Fast single-query member KYC details
router.get("/details/:memberId?", optionalAuth, getMemberKycDetails);

// Submit KYC details
router.post("/submit", optionalAuth, submitKYC);

// Approve KYC
router.post("/approve", approveKYC);

// Get KYC submissions (optional query: ?status=PENDING&q=search&page=1&limit=50)
router.get("/submissions", getKycSubmissions);

// Initiate payout
router.post("/payout", initiatePayout);

// Get beneficiary status
router.get("/beneficiary/:memberId", getBeneficiaryStatus);

module.exports = router;