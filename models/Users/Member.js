const mongoose = require("mongoose");
const moment = require("moment");

const MemberSchema = new mongoose.Schema(
  {
    Member_id: { type: String, required: true, unique: true },
    Name: { type: String, required: true },
    mobileno: { type: String, required: true },
    email: { type: String, required: true },
    state: { type: String },
    city: { type: String },
    address: { type: String },
    pincode: { type: String },
    country: { type: String },
    BMS_bep20_address: { type: String },
    Father_name: { type: String },
    gender: { type: String },
    dob: { type: String },
    password: { type: String, required: true },
    Sponsor_code: { type: String, },
    Sponsor_name: { type: String, },
    Date_of_joining: { type: String, default: () => moment().format("YYYY-MM-DD") },
    spackage: { type: String },
    package_value: { type: Number, set: v => Math.round(v * 10000) / 10000 },
    epin_no: { type: String },
    amount: { type: Number, set: v => Math.round(v * 10000) / 10000 },
    mode_of_payment: { type: String },
    Pan_no: { type: String },
    Nominee_name: { type: String },
    Nominee_age: { type: Number },
    Nominee_Relation: { type: String },
    status: { type: String, enum: ["Pending", "active", "Inactive"], default: "Pending" },
    node: { type: String },
    transaction_pass: { type: String },
    bdb_value: { type: String },
    directreferal_value: { type: String },
    bank_details: { type: String },
    last_logged_in: { type: String },
    google_pay: { type: String },
    phonepe: { type: String },
    member_code: { type: String },
    roi_status: { type: String, enum: ["Active", "Completed", "Pending"], default: "Pending" },
    roi_payout_count: { type: Number, default: 0 },
    roi_payout_target: { type: Number, default: 0 },
    roi_last_payout_date: { type: String },
    roi_start_date: { type: String },
    upgrade_package: { type: String },
    upgrade_status: {
      type: String,
      enum: ["Pending", "Active", "Inactive", "Processing", "Approved", "Completed", "Rejected", "Repaid"],
      default: "Pending"
    },
    level_eligible: { type: String },
    TBPDays: { type: String },
    level_income: { type: String },
    direct_income: { type: String },
    account_number: { type: String },
    ifsc_code: { type: String },
    bank_name: { type: String },
    profile_image: { type: String },
    sponsor_id: { type: String, default: null },
    direct_referrals: { type: [String], default: [] },
    total_team: { type: Number, default: 0 },
    level: { type: Number, default: 0 },
    roi_daily_amount: { type: Number, default: 0, set: v => Math.round(v * 100) / 100 },
    roi_total_paid: { type: Number, default: 0, set: v => Math.round(v * 100) / 100 },
    // KYC fields
    kycStatus: {
      type: String,
      enum: ["PENDING", "PROCESSING", "APPROVED", "REJECTED"],
      default: "PENDING"
    },
    // KYC Document URLs
    panImage: { type: String },
    aadhaarImage: { type: String },
    checkImage: { type: String },
    passbookImage: { type: String },
    rationCardImage: { type: String },
    // Cashfree beneficiary fields
    beneficiaryId: { type: String },
    beneficiaryStatus: {
      type: String,
      enum: ["NOT_CREATED", "FAILED", "CREATED"],
      default: "NOT_CREATED"
    },
    wallet_balance: { type: Number, default: 0, set: v => Math.round(v * 10000) / 10000 },
    upgrade_wallet: { type: Number, default: 0, set: v => Math.round(v * 10000) / 10000 },
    top_up_wallet: { type: Number, default: 0, set: v => Math.round(v * 10000) / 10000 },
    fixed_deposit_wallet: { type: Number, default: 0, set: v => Math.round(v * 10000) / 10000 },
    purchase_wallet: { type: Number, default: 0, set: v => Math.round(v * 10000) / 10000 },
    global_income: { type: Number, default: 0, set: v => Math.round(v * 10000) / 10000 },
    qr_code: { type: String, unique: true, sparse: true },

    // NIDHI SPECIFIC FIELDS (Lowercase mappings)
    member_id: { type: String }, // Counterpart to Member_id
    branch_id: { type: String, default: null },
    receipt_no: { type: String, default: null },
    name: { type: String, default: null }, // Counterpart to Name
    father_name: { type: String, default: null }, // Counterpart to Father_name
    age: { type: Number, default: null },
    emailid: { type: String, default: null }, // Counterpart to email
    contactno: { type: String, default: null }, // Counterpart to mobileno
    pan_no: { type: String, default: null }, // Counterpart to Pan_no
    aadharcard_no: { type: String, default: null },
    voter_id: { type: String, default: null },
    nominee: { type: String, default: null }, // Counterpart to Nominee_name
    relation: { type: String, default: null }, // Counterpart to Nominee_Relation
    occupation: { type: String, default: null },
    introducer: { type: String, default: null }, // Nidhi hierarchy seed
    introducer_name: { type: String, default: null },
    commission_eligible: { type: Boolean, default: true },
    commission_balance: { type: Number, default: 0, set: v => Math.round(v * 10000) / 10000 },
    introducer_hierarchy: { type: [String], default: [] },
    member_image: { type: String, default: null },
    member_signature: { type: String, default: null },
    entered_by: { type: String, default: null },
    role: { type: String, default: "USER" }
  },
  { timestamps: true, collection: "vendor_tbl" }
);

const VendorModel = mongoose.models.vendor_tbl || mongoose.model("vendor_tbl", MemberSchema);
VendorModel.MemberModel = VendorModel;
VendorModel.VendorModel = VendorModel;
module.exports = VendorModel;
