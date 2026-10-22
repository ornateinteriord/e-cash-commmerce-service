const MemberModel = require("../../../models/member.model");
const { addMemberHierarchy } = require("../../../utils/hierarchyHelper");
const { sendMail } = require("../../../utils/EmailService");
const { generateWelcomeEmail } = require("../../../utils/emailTemplates");

// Create a new member
const createMember = async (req, res) => {
    try {
        const {
            branch_id,
            date_of_joining,
            receipt_no,
            name,
            father_name,
            gender,
            dob,
            age,
            address,
            emailid,
            contactno,
            pan_no,
            aadharcard_no,
            voter_id,
            nominee,
            relation,
            occupation,
            introducer,
            introducer_name,
            member_image,
            member_signature,
            entered_by,
            role,
            status,
            commission_eligible
        } = req.body;

        // Auto-increment member_id: Find max member_id and add 1
        // Starting from 105150 if no members exist
        const lastMember = await MemberModel.findOne()
            .sort({ member_id: -1 })
            .limit(1);

        let newMemberId = "105160"; // Start from 105160
        if (lastMember && lastMember.member_id) {
            // Extract numeric part and increment
            const lastId = parseInt(lastMember.member_id);
            if (!isNaN(lastId)) {
                newMemberId = (lastId + 1).toString();
            }
        }

        // Check if introducer is provided (mandatory)
        if (!introducer) {
            return res.status(400).json({
                success: false,
                message: "Introducer is required when creating a member"
            });
        }

        // Check if dob is provided (mandatory)
        if (!dob) {
            return res.status(400).json({
                success: false,
                message: "Date of Birth (dob) is required"
            });
        }

        // Check if contactno already exists
        if (contactno) {
            const existingContact = await MemberModel.findOne({ contactno });
            if (existingContact) {
                return res.status(400).json({
                    success: false,
                    message: "Contact number already exists"
                });
            }
        }

        // Prepare member data
        const memberData = {
            member_id: newMemberId,
            Member_id: newMemberId, // Set both for compatibility
            branch_id,
            date_of_joining,
            receipt_no,
            name,
            Name: name, // Set both for compatibility
            father_name,
            gender,
            dob,
            age,
            address,
            emailid,
            contactno,
            pan_no,
            aadharcard_no,
            voter_id,
            nominee,
            relation,
            occupation,
            introducer,
            introducer_name,
            member_image,
            member_signature,
            entered_by,
            role: role || "USER",
            status: status || "active",
            commission_eligible: commission_eligible !== undefined ? commission_eligible : true
        };

        // 🔥 BUILD INTRODUCER HIERARCHY AUTOMATICALLY
        const memberDataWithHierarchy = await addMemberHierarchy(memberData);

        // Create new member with hierarchy
        const newMember = await MemberModel.create(memberDataWithHierarchy);

        // Create user entry automatically
        const userPassword = contactno; // Password is contact number
        try {
            // Find the last user_id to auto-increment
            // Starting from 105160 if no users exist
            const lastUser = await UserModel.findOne()
                .sort({ user_id: -1 })
                .limit(1);

            let newUserId = "105160"; // Start from 105160
            if (lastUser && lastUser.user_id) {
                const lastId = parseInt(lastUser.user_id);
                if (!isNaN(lastId)) {
                    newUserId = (lastId + 1).toString();
                }
            }

            await UserModel.create({
                id: newUserId,
                user_id: newMemberId,
                user_name: newMemberId,
                reference_id: newMemberId,
                password: userPassword,
                user_role: "USER",
                branch_code: branch_id,
                user_status: "active"
            });

            console.log(`✅ User created successfully for member ${newMemberId}`);
        } catch (userError) {
            console.error("❌ Error creating user entry:", userError);
            // Don't fail the member creation if user creation fails
            // Just log the error
        }

        // 📧 Send welcome email if email provided
        if (emailid) {
            try {
                const emailTemplate = generateWelcomeEmail(name, newMemberId, userPassword, 'Member');
                await sendMail(emailid, emailTemplate.subject, emailTemplate.html, emailTemplate.text);
                console.log(`✅ Welcome email sent to ${emailid}`);
            } catch (emailError) {
                console.error(`❌ Error sending welcome email to ${emailid}:`, emailError.message);
                // Don't fail member creation if email fails
            }
        } else {
            console.log(`ℹ️ No email provided for member ${newMemberId}, skipping welcome email`);
        }

        res.status(201).json({
            success: true,
            message: "Member created successfully",
            data: newMember
        });
    } catch (error) {
        console.error("Error creating member:", error);
        res.status(500).json({
            success: false,
            message: "Failed to create member",
            error: error.message
        });
    }
};

// Get all members
const getMembers = async (req, res) => {
    try {
        const { page = 1, limit = 10, search, status } = req.query;

        // Build filter object
        const filter = {};
        if (status) {
            filter.status = status;
        }
        if (search) {
            filter.$or = [
                { member_id: { $regex: search, $options: "i" } },
                { Member_id: { $regex: search, $options: "i" } },
                { name: { $regex: search, $options: "i" } },
                { Name: { $regex: search, $options: "i" } },
                { contactno: { $regex: search, $options: "i" } },
                { mobileno: { $regex: search, $options: "i" } },
                { emailid: { $regex: search, $options: "i" } },
                { email: { $regex: search, $options: "i" } }
            ];
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const members = await MemberModel.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));

        const totalMembers = await MemberModel.countDocuments(filter);

        res.status(200).json({
            success: true,
            message: "Members fetched successfully",
            data: members,
            pagination: {
                total: totalMembers,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(totalMembers / parseInt(limit))
            }
        });
    } catch (error) {
        console.error("Error fetching members:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch members",
            error: error.message
        });
    }
};

// Update a member by ID
const updateMember = async (req, res) => {
    try {
        const { memberId } = req.params;
        const updateData = req.body;

        // Convert to number if it's a valid number string
        const memberIdAsNumber = parseInt(memberId, 10);
        const isValidNumber = !isNaN(memberIdAsNumber) && memberIdAsNumber.toString() === memberId;

        // Build query conditions
        const queryConditions = [
            { member_id: memberId },
            { Member_id: memberId },
        ];

        if (isValidNumber) {
            queryConditions.push({ member_id: memberIdAsNumber });
            queryConditions.push({ Member_id: memberIdAsNumber });
        }

        // Use $or to query for member_id as string, number, or any format
        const member = await MemberModel.findOne({
            $or: queryConditions
        });

if (!member) {
    return res.status(404).json({
        success: false,
        message: `Member not found with ID: ${memberId}`
    });
}

// If updating contactno, check if it already exists for another member
if (updateData.contactno && updateData.contactno !== member.contactno) {
    const existingContact = await MemberModel.findOne({
        contactno: updateData.contactno,
        _id: { $ne: member._id }  // Use _id instead of member_id for uniqueness
    });
    if (existingContact) {
        return res.status(400).json({
            success: false,
            message: "Contact number already exists for another member"
        });
    }
}

// Update using _id to avoid type issues
const updatedMember = await MemberModel.findByIdAndUpdate(
    member._id,
    { $set: updateData },
    { new: true, runValidators: true }
);



res.status(200).json({
    success: true,
    message: "Member updated successfully",
    data: updatedMember
});
    } catch (error) {
    console.error('[ERROR] Failed to update member:', error);
    res.status(500).json({
        success: false,
        message: "Failed to update member",
        error: error.message
    });
}
};

// Get a single member by ID
const getMemberById = async (req, res) => {
    try {
        const { memberId } = req.params;

        // Convert to number if it's a valid number string
        const memberIdAsNumber = parseInt(memberId, 10);
        const isValidNumber = !isNaN(memberIdAsNumber) && memberIdAsNumber.toString() === memberId;

        // Build query conditions
        const queryConditions = [
            { member_id: memberId },
            { Member_id: memberId },
        ];

        if (isValidNumber) {
            queryConditions.push({ member_id: memberIdAsNumber });
            queryConditions.push({ Member_id: memberIdAsNumber });
        }

        // Use $or to query for member_id
        const member = await MemberModel.findOne({
            $or: queryConditions
        });

if (!member) {
    return res.status(404).json({
        success: false,
        message: "Member not found"
    });
}

res.status(200).json({
    success: true,
    message: "Member fetched successfully",
    data: member
});
    } catch (error) {
    console.error('[ERROR] Failed to fetch member:', error);
    res.status(500).json({
        success: false,
        message: "Failed to fetch member",
        error: error.message
    });
}
};

// Set introducer hierarchy for a member
const setIntroducerHierarchy = async (req, res) => {
    try {
        const { memberId } = req.params;
        const { introducer_id } = req.body;

        // Find the member
        const member = await MemberModel.findOne({
            $or: [
    { member_id: memberId },
    { Member_id: memberId },
    { member_id: parseInt(memberId) }
]
        });

if (!member) {
    return res.status(404).json({
        success: false,
        message: "Member not found"
    });
}

// If no introducer_id provided, use the member's existing introducer
const introducerId = introducer_id || member.introducer;

if (!introducerId) {
    return res.status(400).json({
        success: false,
        message: "No introducer specified"
    });
}

// Find the introducer
const introducer = await MemberModel.findOne({
            $or: [
    { member_id: introducerId },
    { member_id: parseInt(introducerId) }
]
        });

if (!introducer) {
    return res.status(404).json({
        success: false,
        message: "Introducer not found"
    });
}

// Build the hierarchy: [direct introducer, ...introducer's hierarchy]
const newHierarchy = [introducerId];

if (introducer.introducer_hierarchy && introducer.introducer_hierarchy.length > 0) {
    // Add introducer's hierarchy (max 6 more levels for total of 7)
    const existingHierarchy = introducer.introducer_hierarchy.slice(0, 6);
    newHierarchy.push(...existingHierarchy);
}

// Update member
member.introducer = introducerId;
member.introducer_hierarchy = newHierarchy;
await member.save();

console.log(`✅ Updated introducer hierarchy for member ${memberId}:`);
console.log(`   Introducer: ${introducerId}`);
console.log(`   Hierarchy:`, newHierarchy);

res.status(200).json({
    success: true,
    message: "Introducer hierarchy updated successfully",
    data: {
        member_id: member.member_id,
        introducer: introducerId,
        introducer_hierarchy: newHierarchy
    }
});
    } catch (error) {
    console.error("Error setting introducer hierarchy:", error);
    res.status(500).json({
        success: false,
        message: "Failed to set introducer hierarchy",
        error: error.message
    });
}
};

module.exports = {
    createMember,
    getMembers,
    updateMember,
    getMemberById,
    setIntroducerHierarchy,
};
