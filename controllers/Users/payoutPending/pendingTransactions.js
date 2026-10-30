// @desc    Get all pending transactions and member details
// @route   GET /api/transactions/pending

const TransactionModel = require("../../../models/Transaction/Transaction");
const MemberModel = require("../../../models/Users/Member");

// @access  Private/Admin
const getPendingTransactions = async (req, res) => {
  try {
    // Step 1: Get all pending transactions
    const { status } = req.params;
    const pendingTransactions = await TransactionModel.find({ status });

    if (!pendingTransactions.length) {
      return res.json({
        success: true,
        count: 0,
        data: [],
        message: `No ${status} transactions found`,
      });
    }

    // Step 2: For each transaction, get member details
    const transactionsWithMember = await Promise.all(
      pendingTransactions.map(async (txn) => {
        const member = await MemberModel.findOne(
          { $or: [{ Member_id: txn.member_id }, { member_id: txn.member_id }] },
          { mobileno: 1, contactno: 1, ifsc_code: 1, account_number: 1, _id: 0 }
        );
        return {
          ...txn.toObject(),
          memberDetails: member || {},
        };
      })
    );

    // Step 3: Send response
    res.json({
      success: true,
      count: transactionsWithMember.length,
      data: transactionsWithMember,
    });
  } catch (error) {
    console.error("Error fetching pending transactions:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
};
const approveWithdrawal = async (req, res) => {
  try {
    const { transaction_id } = req.params;

    // Find specific pending withdrawal transaction
    const transaction = await TransactionModel.findOne({
      transaction_id: transaction_id,
      status: { $in: ['Pending', 'Processing'] }
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Pending withdrawal not found"
      });
    }

    // Update transaction status to Completed
    transaction.status = 'Completed';
    await transaction.save();

    return res.status(200).json({
      success: true,
      message: "Withdrawal approved successfully",
      data: {
        transactionId: transaction.transaction_id,
        memberId: transaction.member_id,
        amount: parseFloat(transaction.vw_debit) || parseFloat(transaction.ew_debit) || parseFloat(transaction.gross_amount) || 0,
        status: transaction.status
      }
    });
  } catch (error) {
    console.error("Error in approveWithdrawal:", error);
    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};

const rejectWithdrawal = async (req, res) => {
  try {
    const { transaction_id } = req.params;
    const { reason } = req.body || {};

    // Find specific pending withdrawal transaction
    const transaction = await TransactionModel.findOne({
      transaction_id: transaction_id,
      status: { $in: ['Pending', 'Processing'] }
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Pending withdrawal not found"
      });
    }

    transaction.status = 'Rejected';
    if (reason) {
      transaction.description = `Withdrawal Request Rejected: ${reason}`;
    }
    await transaction.save();

    // Refund the debited amount back to member's wallet_balance or vendor_wallet
    const refundAmount = parseFloat(transaction.vw_debit) || parseFloat(transaction.ew_debit) || parseFloat(transaction.gross_amount) || 0;
    if (refundAmount > 0) {
      if (transaction.transaction_type === "Vendor Withdrawal" || parseFloat(transaction.vw_debit) > 0) {
        await MemberModel.findOneAndUpdate(
          { $or: [{ Member_id: transaction.member_id }, { member_id: transaction.member_id }] },
          { $inc: { vendor_wallet: refundAmount } }
        );
      } else {
        await MemberModel.findOneAndUpdate(
          { $or: [{ Member_id: transaction.member_id }, { member_id: transaction.member_id }] },
          { $inc: { wallet_balance: refundAmount } }
        );
      }
    }

    return res.status(200).json({
      success: true,
      message: "Withdrawal rejected and amount refunded successfully",
      data: {
        transactionId: transaction.transaction_id,
        memberId: transaction.member_id,
        refundedAmount: refundAmount,
        status: transaction.status
      }
    });
  } catch (error) {
    console.error("Error in rejectWithdrawal:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message
    });
  }
};

module.exports = {
  getPendingTransactions,
  approveWithdrawal,
  rejectWithdrawal
};
