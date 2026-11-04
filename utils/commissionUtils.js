const fs = require("fs");
const path = require("path");
const MemberModel = require("../models/member.model");
const AgentModel = require("../models/agent.model");
const CommissionModel = require("../models/commission.model");
const AccountsModel = require("../models/accounts.model");

// Load commission configuration
const loadCommissionConfig = () => {
    try {
        const configPath = path.join(__dirname, "../config/commission.config.json");
        const configData = fs.readFileSync(configPath, "utf8");
        return JSON.parse(configData);
    } catch (error) {
        console.error("Error loading commission config:", error);
        throw new Error("Failed to load commission configuration");
    }
};

// Save commission configuration (for admin updates)
const saveCommissionConfig = (config) => {
    try {
        const configPath = path.join(__dirname, "../config/commission.config.json");
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
        return true;
    } catch (error) {
        console.error("Error saving commission config:", error);
        throw new Error("Failed to save commission configuration");
    }
};

// Get introducer hierarchy for a member or agent
const getIntroducerHierarchy = async (userId, userType) => {
    try {
        let user;
        if (userType === "MEMBER") {
            user = await MemberModel.findOne({ 
                $or: [
    { member_id: userId },
    { Member_id: userId }
]
            });
        } else if (userType === "AGENT") {
    user = await AgentModel.findOne({ agent_id: userId });
}

if (!user) {
    return [];
}

return user.introducer_hierarchy || [];
    } catch (error) {
    console.error("Error getting introducer hierarchy:", error);
    return [];
}
};

// Build introducer hierarchy when creating new member/agent
const buildIntroducerHierarchy = async (introducerId, introducerType) => {
    try {
        if (!introducerId) {
            return [];
        }

        let introducer;
        if (introducerType === "MEMBER") {
            introducer = await MemberModel.findOne({ 
                $or: [
    { member_id: introducerId },
    { Member_id: introducerId }
]
            });
        } else if (introducerType === "AGENT") {
    introducer = await AgentModel.findOne({ agent_id: introducerId });
}

if (!introducer) {
    return [introducerId]; // Just the direct introducer
}

// Start with the direct introducer
const hierarchy = [introducerId];

// Add the introducer's hierarchy (up to 19 more levels for total of 20)
if (introducer.introducer_hierarchy && introducer.introducer_hierarchy.length > 0) {
    // Filter out any duplicates - don't include introducerId again if it's already in their hierarchy
    const existingHierarchy = introducer.introducer_hierarchy
        .filter(id => id !== introducerId && id !== String(introducerId)) // Remove duplicates
        .slice(0, 19);
    hierarchy.push(...existingHierarchy);
}

// Ensure no duplicates in final hierarchy (just in case)
const uniqueHierarchy = [...new Set(hierarchy.map(String))];

return uniqueHierarchy.slice(0, 20); // Max 20 levels
    } catch (error) {
    console.error("Error building introducer hierarchy:", error);
    return introducerId ? [introducerId] : [];
}
};

// Validate if transaction is eligible for commission
const validateCommissionEligibility = (transaction, config) => {
    // DISABLED / COMMENTED OUT: Banking & Pigmy commission system is currently not in use
    return { eligible: false, reason: "Banking / Pigmy deposit commission system is disabled" };

    /*
    console.log("\n🔍 Checking Commission Eligibility:");
    console.log(`   Commission System: ${config.enabled ? '✅ Enabled' : '❌ Disabled'}`);

    if (!config.enabled) {
        console.log("   Result: ❌ Not Eligible - System disabled");
        return { eligible: false, reason: "Commission system is disabled" };
    }

    // NEW: Restrict to "Account Opening" only
    console.log(`   Transaction Type: ${transaction.transaction_type}`);
    if (transaction.transaction_type !== "Account Opening") {
        console.log("   Result: ❌ Not Eligible - Not an 'Account Opening' transaction");
        return {
            eligible: false,
            reason: "Only 'Account Opening' transactions are eligible for commission"
        };
    }

    console.log(`   Transaction Amount: ₹${transaction.credit}`);

    // Check if account type is commission-eligible (e.g. Pigmy/AGP005)
    const accountTypeId = transaction.account_type?.toString();
    const eligibleTypes = config.eligibleAccountTypes || [];

    console.log(`   Account Type ID: ${accountTypeId}`);
    console.log(`   Eligible Types: ${eligibleTypes.join(', ')}`);

    if (!eligibleTypes.includes(accountTypeId)) {
        console.log("   Result: ❌ Not Eligible - Account type not eligible");
        return {
            eligible: false,
            reason: "Account type not eligible for commission",
        };
    }

    console.log("   Result: ✅ Eligible for Commission!");
    return { eligible: true };
    */
};

// Map account type ID to name
const getAccountTypeName = (accountTypeId, config) => {
    const mapping = config.accountTypeMapping || {
        "1": "FD",
        "2": "RD",
        "3": "Pigmy",
    };
    return mapping[accountTypeId?.toString()] || "Other";
};

// Check if a member is a senior citizen based on date of birth
const isSeniorCitizen = (dateOfBirth, ageThreshold = 60) => {
    if (!dateOfBirth) {
        return false;
    }

    try {
        const dob = new Date(dateOfBirth);
        const today = new Date();
        let age = today.getFullYear() - dob.getFullYear();
        const monthDiff = today.getMonth() - dob.getMonth();

        // Adjust age if birthday hasn't occurred this year
        if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
            age--;
        }

        return age >= ageThreshold;
    } catch (error) {
        console.error("Error calculating age:", error);
        return false;
    }
};

// Calculate commissions for a transaction
const calculateCommissions = async (transaction) => {
    try {
        const config = loadCommissionConfig();

        // Validate eligibility
        const eligibility = validateCommissionEligibility(transaction, config);
        if (!eligibility.eligible) {
            console.log(`Transaction ${transaction.transaction_id} not eligible: ${eligibility.reason}`);
            return [];
        }

        // Get member/agent details
        const memberId = transaction.member_id;
        let sourceUser;
        let sourceType = "MEMBER";

        // Try to find as member first (search both case variants)
        sourceUser = await MemberModel.findOne({ 
            $or: [
    { member_id: memberId },
    { Member_id: memberId }
]
        });

if (!sourceUser) {
    // Try as agent
    sourceUser = await AgentModel.findOne({ agent_id: memberId });
    sourceType = "AGENT";
}

if (!sourceUser) {
    console.log(`Source user not found: ${memberId}`);
    return [];
}

// Check if source is commission eligible
if (!sourceUser.commission_eligible) {
    console.log(`Source user ${memberId} not eligible for commission`);
    return [];
}

// Check if source member is a senior citizen
const ageThreshold = config.seniorCitizenAgeThreshold || 60;
// Try various field names for DOB and Name
const dobField = sourceUser.dob || sourceUser.date_of_birth || sourceUser.Date_of_birth;
const sourceName = sourceUser.name || sourceUser.Name || `Member-${memberId}`;

const isSenior = isSeniorCitizen(dobField, ageThreshold);
const citizenType = isSenior ? "seniorCitizen" : "general";

console.log(`\n👤 Source Member Info:`);
console.log(`   Name: ${sourceName}`);
console.log(`   DOB: ${dobField}`);
console.log(`   Age Threshold: ${ageThreshold}`);
console.log(`   Status: ${isSenior ? '🧓 Senior Citizen' : '👥 General'}`);

// Get introducer hierarchy
let hierarchy = sourceUser.introducer_hierarchy || [];

// If hierarchy is empty, try to build it on the fly using sponsor fields
if (hierarchy.length === 0) {
    const sponsorId = sourceUser.introducer || sourceUser.sponsor_id || sourceUser.Sponsor_code;
    if (sponsorId) {
        console.log(`Building on-the-fly hierarchy for ${memberId} using sponsor: ${sponsorId}`);
        // Try to find if sponsor is an agent or member
        let sponsorType = "MEMBER";
        let sponsor = await MemberModel.findOne({ $or: [{ member_id: sponsorId }, { Member_id: sponsorId }] });
        if (!sponsor) {
            sponsor = await AgentModel.findOne({ agent_id: sponsorId });
            sponsorType = "AGENT";
        }

        if (sponsor) {
            const { buildIntroducerHierarchy } = require("./commissionUtils");
            hierarchy = await buildIntroducerHierarchy(sponsorId, sponsorType);
            console.log(`Generated hierarchy: ${hierarchy.join(' -> ')}`);
        }
    }
}

if (hierarchy.length === 0) {
    console.log(`No introducer or sponsor hierarchy for ${memberId}`);
    return [];
}

const accountTypeName = getAccountTypeName(transaction.account_type, config);
const transactionAmount = transaction.credit || 0;
const commissions = [];

// Calculate commission for each level
// Track which beneficiaries have already received commission to avoid duplicates
const processedBeneficiaries = new Set();

for (let i = 0; i < Math.min(hierarchy.length, 20); i++) {
    const level = i + 1;
    const beneficiaryId = hierarchy[i];

    // Skip if this beneficiary has already received commission at a higher level
    if (processedBeneficiaries.has(beneficiaryId)) {
        console.log(`Skipping duplicate beneficiary at level ${level}: ${beneficiaryId} (already processed at higher level)`);
        continue;
    }

    // Find the beneficiary
    let beneficiary = await MemberModel.findOne({ 
                $or: [
        { member_id: beneficiaryId },
        { Member_id: beneficiaryId }
    ]
});
let beneficiaryType = "MEMBER";

if (!beneficiary) {
    beneficiary = await AgentModel.findOne({ agent_id: beneficiaryId });
    beneficiaryType = "AGENT";
}

if (!beneficiary) {
    console.log(`Beneficiary not found at level ${level}: ${beneficiaryId}`);
    continue;
}

// Check if beneficiary is commission eligible
if (!beneficiary.commission_eligible) {
    console.log(`Beneficiary ${beneficiaryId} not eligible for commission`);
    continue;
}

// Get commission rate for this level and account type
// Use new commissionLevels structure (same rate for everyone - no senior citizen differentiation)
const commissionLevels = config.commissionLevels?.levels || config.levels || [];
const levelConfig = commissionLevels.find((l) => l.level === level);
if (!levelConfig) {
    console.log(`No config found for level ${level}`);
    continue;
}

// Get rate directly (new simplified structure) or from old rates structure
let commissionRate;
if (levelConfig[accountTypeName] !== undefined) {
    // New simplified structure: { level: 1, FD: 4.50, RD: 4.50, ... }
    commissionRate = levelConfig[accountTypeName];
} else if (levelConfig.rates) {
    // Old structure with rates object
    const rateConfig = levelConfig.rates[accountTypeName];
    if (typeof rateConfig === 'object' && rateConfig !== null) {
        commissionRate = rateConfig[citizenType];
    } else {
        commissionRate = rateConfig;
    }
}

if (commissionRate === undefined || commissionRate === null) {
    console.log(`No rate found for ${accountTypeName} at level ${level}`);
    continue;
}

// Calculate commission amount
const commissionAmount = (transactionAmount * commissionRate) / 100;

// Mark this beneficiary as processed
processedBeneficiaries.add(beneficiaryId);

// Get beneficiary name with fallback for empty/null names
const beneficiaryName = (beneficiary.name || beneficiary.Name || "").trim() || `Member-${beneficiaryId}`;
const finalSourceName = (sourceUser.name || sourceUser.Name || "").trim() || `Member-${memberId}`;

commissions.push({
    level,
    beneficiary_id: beneficiaryId,
    beneficiary_name: beneficiaryName,
    beneficiary_type: beneficiaryType,
    source_id: memberId,
    source_name: finalSourceName,
    source_type: sourceType,
    source_citizen_type: citizenType,
    is_senior_citizen: isSenior,
    transaction_id: transaction.transaction_id,
    transaction_date: transaction.transaction_date || new Date(),
    account_type: accountTypeName,
    account_type_id: transaction.account_type?.toString(),
    transaction_amount: transactionAmount,
    commission_rate: commissionRate,
    commission_amount: commissionAmount,
});
        }

return commissions;
    } catch (error) {
    console.error("Error calculating commissions:", error);
    return [];
}
};

// Generate unique commission ID
const generateCommissionId = async () => {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000);
    return `COMM${timestamp}${random}`;
};

// Distribute and credit commissions
const distributeCommissions = async (commissions) => {
    const results = {
        successful: [],
        failed: [],
    };

    for (const commission of commissions) {
        try {
            // Generate commission ID
            const commissionId = await generateCommissionId();

            // Create commission record
            const commissionRecord = new CommissionModel({
                commission_id: commissionId,
                ...commission,
                status: "PENDING",
            });

            await commissionRecord.save();

            // Credit the commission amount to beneficiary
            if (commission.beneficiary_type === "AGENT") {
                // For agents, credit directly to their commission_balance field
                const agent = await AgentModel.findOne({
                    $or: [
    { agent_id: commission.beneficiary_id },
    { agent_id: String(commission.beneficiary_id) }
]
                });

if (agent) {
    // Update agent's commission balance using updateOne to bypass validation
    const newBalance = (parseFloat(agent.commission_balance) || 0) + commission.commission_amount;
    await AgentModel.updateOne(
        { _id: agent._id },
        { $set: { commission_balance: newBalance } }
    );

    // Update commission record as credited
    commissionRecord.status = "CREDITED";
    commissionRecord.credited_at = new Date();
    await commissionRecord.save();

    console.log(`✅ Commission credited to agent ${commission.beneficiary_id}: ₹${commission.commission_amount}`);

    results.successful.push({
        commission_id: commissionId,
        beneficiary_id: commission.beneficiary_id,
        amount: commission.commission_amount,
    });
} else {
    // Agent not found - mark as failed
    commissionRecord.status = "FAILED";
    commissionRecord.failure_reason = "Agent not found";
    await commissionRecord.save();

    results.failed.push({
        commission_id: commissionId,
        beneficiary_id: commission.beneficiary_id,
        reason: "Agent not found",
    });
}
            } else {
    // For members, credit to their commission_balance and optionally to account
    const member = await MemberModel.findOne({
                    $or: [
        { member_id: commission.beneficiary_id },
        { Member_id: commission.beneficiary_id }
    ]
});

if (member) {
    // Update member's commission balance only
    // NOTE: Commission is NOT added to account balance - it goes to commission_balance only
    // Use updateOne to bypass validation (some members may have empty required fields like 'introducer')
    const newBalance = (parseFloat(member.commission_balance) || 0) + commission.commission_amount;
    await MemberModel.updateOne(
        { _id: member._id },
        { $set: { commission_balance: newBalance } }
    );

    // Update commission record as credited
    commissionRecord.status = "CREDITED";
    commissionRecord.credited_at = new Date();
    await commissionRecord.save();

    console.log(`✅ Commission credited to member ${commission.beneficiary_id}: ₹${commission.commission_amount}`);

    results.successful.push({
        commission_id: commissionId,
        beneficiary_id: commission.beneficiary_id,
        amount: commission.commission_amount,
    });
} else {
    // Member not found - mark as failed
    commissionRecord.status = "FAILED";
    commissionRecord.failure_reason = "Member not found";
    await commissionRecord.save();

    results.failed.push({
        commission_id: commissionId,
        beneficiary_id: commission.beneficiary_id,
        reason: "Member not found",
    });
}
            }
        } catch (error) {
    console.error("Error distributing commission:", error);
    results.failed.push({
        beneficiary_id: commission.beneficiary_id,
        reason: error.message,
    });
}
    }

return results;
};

// Process commission for a completed transaction
const processTransactionCommission = async (transaction) => {
    // DISABLED / COMMENTED OUT: Banking & Pigmy commission system is not in use
    return {
        success: true,
        message: "Banking deposit and Pigmy commission system is currently disabled",
        commissions: [],
    };

    /*
    try {
        console.log("\n" + "=".repeat(60));
        console.log("🎯 COMMISSION PROCESSING STARTED");
        console.log("=".repeat(60));
        console.log(`📄 Transaction ID: ${transaction.transaction_id}`);
        console.log(`👤 Member ID: ${transaction.member_id}`);
        console.log(`💰 Amount: ₹${transaction.credit}`);
        console.log(`🏦 Account Type: ${transaction.account_type}`);
        console.log("-".repeat(60));

        // Calculate commissions
        const commissions = await calculateCommissions(transaction);

        if (commissions.length === 0) {
            console.log("❌ No commissions to distribute");
            console.log("   Possible reasons:");
            console.log("   - Member has no introducer");
            console.log("   - Amount below minimum (₹100)");
            console.log("   - Commission system disabled");
            console.log("   - Account type not eligible");
            console.log("=".repeat(60) + "\n");
            return {
                success: true,
                message: "No commissions applicable",
                commissions: [],
            };
        }

        console.log(`✅ Found ${commissions.length} commission(s) to distribute:`);
        commissions.forEach((comm, index) => {
            console.log(`\n   Commission ${index + 1}:`);
            console.log(`   └─ Level: ${comm.level}`);
            console.log(`   └─ Beneficiary: ${comm.beneficiary_name} (${comm.beneficiary_id})`);
            console.log(`   └─ Rate: ${comm.commission_rate}%`);
            console.log(`   └─ Amount: ₹${comm.commission_amount.toFixed(2)}`);
        });
        console.log("-".repeat(60));

        // Distribute commissions
        console.log("\n💳 DISTRIBUTING COMMISSIONS...");
        const results = await distributeCommissions(commissions);

        console.log("\n📊 DISTRIBUTION RESULTS:");
        console.log(`   ✅ Successful: ${results.successful.length}`);
        console.log(`   ❌ Failed: ${results.failed.length}`);

        if (results.successful.length > 0) {
            console.log("\n   Credited:");
            results.successful.forEach(s => {
                console.log(`   ✓ ${s.beneficiary_id}: ₹${s.amount.toFixed(2)}`);
            });
        }

        if (results.failed.length > 0) {
            console.log("\n   Failed:");
            results.failed.forEach(f => {
                console.log(`   ✗ ${f.beneficiary_id}: ${f.reason}`);
            });
        }

        console.log("\n" + "=".repeat(60));
        console.log("✅ COMMISSION PROCESSING COMPLETED");
        console.log("=".repeat(60) + "\n");

        return {
            success: true,
            message: "Commission processing completed",
            results,
        };
    } catch (error) {
        console.error("\n" + "=".repeat(60));
        console.error("❌ COMMISSION PROCESSING ERROR");
        console.error("=".repeat(60));
        console.error("Error:", error.message);
        console.error("Stack:", error.stack);
        console.error("=".repeat(60) + "\n");
        return {
            success: false,
            message: "Commission processing failed",
            error: error.message,
        };
    }
    */
};

module.exports = {
    loadCommissionConfig,
    saveCommissionConfig,
    getIntroducerHierarchy,
    buildIntroducerHierarchy,
    validateCommissionEligibility,
    calculateCommissions,
    distributeCommissions,
    processTransactionCommission,
    getAccountTypeName,
    isSeniorCitizen,
};
