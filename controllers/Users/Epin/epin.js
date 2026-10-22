const EpinModel = require("../../../models/Epin/epin");

const getEpins = async (req, res) => {
    try {
        const { status } = req.query;
        const purchasedby = req.user?.memberId;

        if (!purchasedby) {
            return res.status(400).json({ success: false, message: "Invalid User" });
        }

        let filter = { purchasedby };
        if (status) filter.status = status;

        const epins = await EpinModel.find(filter);
        res.status(200).json({ success: true, data: epins });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const getEpinsSummary = async (req, res) => {
    try {
        const activeEpins = await EpinModel.aggregate([
            { $match: { status: "active" } },
            { $group: { _id: "$purchasedby", count: { $sum: 1 } } },
            { $project: { memberCode: "$_id", usedQuantity: "$count", status: "active", _id: 0 } }
        ]);

        const usedEpins = await EpinModel.aggregate([
            { $match: { status: "used" } },
            { $group: { _id: "$purchasedby", count: { $sum: 1 } } },
            { $project: { memberCode: "$_id", usedQuantity: "$count", status: "used", _id: 0 } }
        ]);
        const totalEpins = await EpinModel.aggregate([
            { $group: { _id: { purchasedby: "$purchasedby", date: "$date" }, count: { $sum: 1 } } },
            { $project: {
                memberCode: "$_id.purchasedby",
                date: "$_id.date", totalQuantity: "$count", _id: 0
            }
            }
        ]);

        res.status(200).json({
            success: true,
            data: {
                activeEpins,
                usedEpins,
                totalEpins
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const transferEpin = async (req, res) => {
    try {
        const { quantity, transfered_on, transfered_to } = req.body;
        const memberId = req.user?.memberId;
        const activeEpins = await EpinModel.find({ purchasedby: memberId, status: "active" });
        if (activeEpins.length === 0) {
            return res.status(400).json({ success: false, message: "No active epins available" });
        }

        if (!memberId) {
            return res.status(400).json({ success: false, message: "Invalid user" });
        }

        // Restrict transferring to oneself
        if (transfered_to === memberId) {
            return res.status(400).json({ success: false, message: "You cannot transfer your package to yourself" });
        }

        if (quantity > activeEpins.length) {
            return res.status(400).json({
                success: false,
                message: `Qty is not available`
            });
        }
        if (!transfered_to) {
            return res.status(400).json({
                success: false,
                message: `Transfered to is required`
            });
        }

        const epinsToUpdate = activeEpins.slice(0, quantity);
        const epinIds = epinsToUpdate.map(epin => epin.epin_id); // Extract IDs

        // Update the epins
        await EpinModel.updateMany(
            { epin_id: { $in: epinIds } },
            {
                $set: {
    transfered_by: memberId,
        transfered_on,
        transfered_to,
        purchasedby: transfered_to, 
                }
            }
        );

res.status(200).json({ success: true, message: "Package transferred successfully" });
    } catch (error) {
    res.status(500).json({ success: false, message: error.message });
}
};

const getPackageHistory = async (req, res) => {
    try {
        const memberId = req.user?.memberId;
        if (!memberId) {
            return res.status(400).json({ success: false, message: "Invalid user" });
        }

        const epins = await EpinModel.aggregate([
            {
                $match: { transfered_by: memberId, status: "active" }
            },
{
                $lookup: {
        from: "vendor_tbl",
            localField: "transfered_to",
                foreignField: "Member_id",
                    as: "memberInfo"
    }
},
{
                $unwind: {
        path: "$memberInfo",
            preserveNullAndEmptyArrays: true
    }
},
{
                $group: {
        _id: { transfered_on: "$transfered_on", transfered_to: "$transfered_to", spackage: "$spackage" },
        quantity: { $sum: 1 },
        amount: { $first: "$amount" },
        transfered_to_name: { $first: "$memberInfo.Name" }
    }
},
{
                $project: {
        _id: 0,
            date: "$_id.transfered_on",
                transfered_to: {
                        $cond: {
                if: { $eq: ["$transfered_to_name", null] },
                then: { $concat: ["(", "$_id.transfered_to", ")"] },
                            else: { $concat: ["$transfered_to_name", " ( ", "$_id.transfered_to", " )"] }
            }
        },
        quantity: "$quantity",
            package: { $concat: ["$_id.spackage", " - ", { $toString: "$amount" }] }
    }
},
{ $sort: { date: -1 } }
        ]);

if (!epins.length) {
    return res.status(400).json({ success: false, message: "No active epins available" });
}

res.status(200).json({ success: true, epins });
    } catch (error) {
    res.status(500).json({ success: false, message: error.message });
}
};

const generatePackage = async (req, res) => {
    try {
        const { spackage, purchasedby, quantity, amount, generated_by } = req.body;

        if (!spackage || !purchasedby || !quantity || !amount) {
            return res.status(400).json({ success: false, message: "All fields are required!" });
        }

        if (quantity <= 0) {
            return res.status(400).json({ success: false, message: "Quantity must be at least 1!" });
        }

        let savedEpins = [];

        for (let i = 0; i < quantity; i++) {
            const lastEpin = await EpinModel.aggregate([
                { $sort: { epin_id: -1 } },
                { $limit: 1 },
                { $project: { epin_id: 1 } }
            ]);
            const newEpinId = lastEpin.length > 0 ? lastEpin[0].epin_id + 1 : 1;
            let formattedAmount = `${amount} (${formatAmount(amount)})`;
            let newEpin = new EpinModel({
                epin_id: newEpinId,
                date: new Date().toISOString().split("T")[0],
                epin_no: generateUniqueEpin(),
                purchasedby,
                spackage,
                amount: formattedAmount,
                status: "active",
                generated_by
            });

            const savedEpin = await newEpin.save();
            savedEpins.push(savedEpin);
        }


        return res.status(201).json({ success: true, message: "Package  generated successfully!" });

    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

const generateUniqueEpin = () => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let epinNo = "";
    for (let i = 0; i < 7; i++) {
        epinNo += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return epinNo;
};

const formatAmount = (num) => {
    let formatted = new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1
    }).format(num);
    if (!formatted.includes(".")) {
        formatted = formatted.replace(/(\d+)/, "$1.0");
    }
    return formatted;
};

module.exports = { getEpins, getEpinsSummary, transferEpin, generatePackage, getPackageHistory };