const { signup, login, getSponsorDetails, resetPassword, impersonate, sendRegistrationOTP, verifyRegistrationOTP, checkMobile } = require("../controllers/Auth/AuthController");
const Authenticated = require("../middlewares/auth");
const authorizeRoles = require("../middlewares/authorizeRole");

const router = require("express").Router();

router.post("/signup", signup);
router.post("/send-registration-otp", sendRegistrationOTP);
router.post("/check-mobile", checkMobile);
router.post("/verify-registration-otp", verifyRegistrationOTP);
router.get("/get-sponsor/:ref", getSponsorDetails);
router.post("/reset-password", resetPassword);
router.post("/login", login);

// Admin only impersonation
router.post("/impersonate", Authenticated, authorizeRoles("ADMIN"), impersonate);

module.exports = router;

