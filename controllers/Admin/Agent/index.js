const AgentModel = require("../../../models/agent.model");
const { sendMail } = require("../../../utils/EmailService");
const { generateWelcomeEmail } = require("../../../utils/emailTemplates");
const { addAgentHierarchy } = require("../../../utils/hierarchyHelper");

// Create a new agent
const createAgent = async (req, res) => {
    try {
        const {
            branch_id,
            date_of_joining,
            name,
            gender,
            dob,
            address,
            emailid,
            mobile,
            pan_no,
            aadharcard_no,
            introducer,
            entered_by,
            designation,
            status
        } = req.body;

        // Auto-increment agent_id with A2 prefix: Find max agent_id and add 1
        const lastAgent = await AgentModel.findOne()
            .sort({ agent_id: -1 })
            .limit(1);

        let newAgentId = "A20001"; // Default starting ID
        if (lastAgent && lastAgent.agent_id) {
            // Extract numeric part from format "A2XXXX" and increment
            const numericPart = lastAgent.agent_id.replace(/^A2/, '');
            const lastId = parseInt(numericPart);
            if (!isNaN(lastId)) {
                const nextId = lastId + 1;
                // Format with A2 prefix and pad to 4 digits
                newAgentId = `A2${nextId.toString().padStart(4, '0')}`;
            }
        }

        // Check if mobile already exists
        if (mobile) {
            const existingMobile = await AgentModel.findOne({ mobile });
            if (existingMobile) {
                return res.status(400).json({
                    success: false,
                    message: "Mobile number already exists"
                });
            }
        }

        // Prepare agent data with hierarchy
        const agentData = {
            agent_id: newAgentId,
            branch_id,
            date_of_joining,
            name,
            gender,
            dob,
            address,
            emailid,
            mobile,
            pan_no,
            aadharcard_no,
            introducer,
            entered_by,
            designation,
            status: status || "active",
            commission_eligible: true
        };

        const agentDataWithHierarchy = await addAgentHierarchy(agentData);
        const newAgent = await AgentModel.create(agentDataWithHierarchy);

        // Create user entry automatically
        try {
            // Find the last user_id to auto-increment
            const lastUser = await UserModel.findOne()
                .sort({ user_id: -1 })
                .limit(1);

            let newUserId = "1";
            if (lastUser && lastUser.user_id) {
                const lastId = parseInt(lastUser.user_id);
                if (!isNaN(lastId)) {
                    newUserId = (lastId + 1).toString();
                }
            }

            await UserModel.create({
                id: newUserId,
                user_id: newAgentId,
                user_name: newAgentId,
                reference_id: newAgentId,
                password: mobile,
                user_role: "AGENT",
                branch_code: branch_id,
                user_status: "active"
            });

            console.log(`✅ User created successfully for agent ${newAgentId}`);
        } catch (userError) {
            console.error("❌ Error creating user entry:", userError);
            // Don't fail the agent creation if user creation fails
            // Just log the error
        }

        // 📧 Send welcome email if email provided
        if (emailid) {
            try {
                const emailTemplate = generateWelcomeEmail(name, newAgentId, mobile, 'Agent');
                await sendMail(emailid, emailTemplate.subject, emailTemplate.html, emailTemplate.text);
                console.log(`✅ Welcome email sent to ${emailid}`);
            } catch (emailError) {
                console.error(`❌ Error sending welcome email to ${emailid}:`, emailError.message);
                // Don't fail agent creation if email fails
            }
        } else {
            console.log(`ℹ️ No email provided for agent ${newAgentId}, skipping welcome email`);
        }

        res.status(201).json({
            success: true,
            message: "Agent created successfully",
            data: newAgent
        });
    } catch (error) {
        console.error("Error creating agent:", error);
        res.status(500).json({
            success: false,
            message: "Failed to create agent",
            error: error.message
        });
    }
};

// Get all agents
const getAgents = async (req, res) => {
    try {
        const { page = 1, limit = 10, search, status } = req.query;

        // Build filter object
        const filter = {};
        if (status) {
            filter.status = status;
        }
        if (search) {
            filter.$or = [
                { agent_id: { $regex: search, $options: "i" } },
                { name: { $regex: search, $options: "i" } },
                { mobile: { $regex: search, $options: "i" } },
                { emailid: { $regex: search, $options: "i" } }
            ];
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const agents = await AgentModel.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));

        const totalAgents = await AgentModel.countDocuments(filter);

        res.status(200).json({
            success: true,
            message: "Agents fetched successfully",
            data: agents,
            pagination: {
                total: totalAgents,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(totalAgents / parseInt(limit))
            }
        });
    } catch (error) {
        console.error("Error fetching agents:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch agents",
            error: error.message
        });
    }
};

// Update an agent by ID
const updateAgent = async (req, res) => {
    try {
        const { agentId } = req.params;
        const updateData = req.body;

        // Find agent by agent_id
        const agent = await AgentModel.findOne({ agent_id: agentId });
        if (!agent) {
            return res.status(404).json({
                success: false,
                message: "Agent not found"
            });
        }

        // If updating mobile, check if it already exists for another agent
        if (updateData.mobile && updateData.mobile !== agent.mobile) {
            const existingMobile = await AgentModel.findOne({
                mobile: updateData.mobile,
                agent_id: { $ne: agentId }
            });
            if (existingMobile) {
                return res.status(400).json({
                    success: false,
                    message: "Mobile number already exists for another agent"
                });
            }
        }

        // Update the agent
        const updatedAgent = await AgentModel.findOneAndUpdate(
            { agent_id: agentId },
            { $set: updateData },
            { new: true, runValidators: true }
        );

        res.status(200).json({
            success: true,
            message: "Agent updated successfully",
            data: updatedAgent
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Failed to update agent",
            error: error.message
        });
    }
};

// Get a single agent by ID
const getAgentById = async (req, res) => {
    try {
        const { agentId } = req.params;

        // Use direct findOne with $or to handle any data type
        const agent = await AgentModel.findOne({
            $or: [
    { agent_id: agentId },
    { agent_id: agentId.toString() }
]
        });

if (!agent) {
    return res.status(404).json({
        success: false,
        message: "Agent not found"
    });
}

res.status(200).json({
    success: true,
    message: "Agent fetched successfully",
    data: agent
});
    } catch (error) {
    res.status(500).json({
        success: false,
        message: "Failed to fetch agent",
        error: error.message
    });
}
};

module.exports = {
    createAgent,
    getAgents,
    updateAgent,
    getAgentById
};
