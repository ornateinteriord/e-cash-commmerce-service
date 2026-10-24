const generateMSCSEmail = (memberId, password, name = 'Member') => {
  const welcomeSubject = 'E shopy - Account Registration Successful';

  const welcomeMessage = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #111827; border-radius: 12px; border: 1px solid #374151;">
      <!-- Brand Header -->
      <div style="text-align: center; margin-bottom: 10px;">
        <h1 style="color: #38bdf8; text-align: center; margin: 0 0 10px 0; font-size: 32px; font-weight: 900; letter-spacing: 2px;">E shopy</h1>
      </div>
      
      <!-- Content -->
      <div style="background-color: #1f2937; padding: 30px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);">
        <h2 style="color: #ffffff; margin-top: 0; text-align: center; font-size: 24px;">Welcome to E shopy!</h2>
        
        <p style="color: #d1d5db; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
          Dear <strong style="color: #fbbf24;">${name}</strong>,
        </p>

        <p style="color: #ffffff; font-size: 16px; line-height: 1.6; margin-bottom: 25px;">
          Congratulations! Your account registration has been successfully completed. We are thrilled to welcome you to the community.
        </p>

        <!-- Credentials Box -->
        <div style="background-color: #374151; border-left: 4px solid #fbbf24; padding: 20px; margin: 25px 0; border-radius: 4px;">
          <h3 style="color: #fbbf24; margin-top: 0; margin-bottom: 15px; font-size: 18px;">Your Login Credentials</h3>
          <p style="margin: 8px 0; color: #d1d5db; font-size: 15px;"><strong>Member ID:</strong> <span style="color: #ffffff;">${memberId}</span></p>
          <p style="margin: 8px 0; color: #d1d5db; font-size: 15px;"><strong>Password:</strong> <span style="color: #ffffff;">${password}</span></p>
        </div>

        <p style="color: #9ca3af; font-size: 14px; line-height: 1.6; margin-bottom: 20px;">
          <strong>Security Notice:</strong> Please keep your login credentials strictly confidential and do not share them with anyone.
        </p>
      </div>

      <!-- Footer -->
      <div style="text-align: center; margin-top: 25px; color: #9ca3af; font-size: 12px;">
        &copy; ${new Date().getFullYear()} E shopy. All rights reserved.
      </div>
    </div>
  `;

  return { welcomeMessage, welcomeSubject };
};

const generateTopUpApprovedEmail = (name, amount) => {
  const subject = 'E shopy - Fund Load Approved';

  const htmlContent = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #111827; border-radius: 12px; border: 1px solid #374151;">
      <!-- Brand Header -->
      <div style="text-align: center; margin-bottom: 10px;">
        <h1 style="color: #38bdf8; text-align: center; margin: 0 0 10px 0; font-size: 32px; font-weight: 900; letter-spacing: 2px;">E shopy</h1>
      </div>
      
      <!-- Content -->
      <div style="background-color: #1f2937; padding: 30px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);">
        <h2 style="color: #ffffff; margin-top: 0; text-align: center; font-size: 24px;">Fund Load Approved</h2>
        
        <p style="color: #ffffff; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
          Dear <strong style="color: #fbbf24;">${name}</strong>,
        </p>

        <p style="color: #ffffff; font-size: 16px; line-height: 1.6; margin-bottom: 25px;">
          Your request to load funds into your Top Up Wallet has been approved by the Administrator.
        </p>

        <div style="background-color: #374151; border-left: 4px solid #10b981; padding: 20px; margin: 25px 0; border-radius: 4px;">
          <h3 style="color: #10b981; margin-top: 0; margin-bottom: 15px; font-size: 18px;">Transaction Details</h3>
          <p style="margin: 8px 0; color: #d1d5db; font-size: 15px;"><strong>Status:</strong> <span style="color: #ffffff;">Approved</span></p>
          <p style="margin: 8px 0; color: #d1d5db; font-size: 15px;"><strong>Credited Amount:</strong> <span style="color: #ffffff;">₹${amount}</span></p>
        </div>

        <p style="color: #9ca3af; font-size: 14px; line-height: 1.6; margin-bottom: 20px;">
          The requested amount has been successfully added to your Top Up Wallet. You can now use these funds for upgrading packages or internal transfers.
        </p>
      </div>

      <!-- Footer -->
      <div style="text-align: center; margin-top: 25px; color: #9ca3af; font-size: 12px;">
        &copy; ${new Date().getFullYear()} E shopy. All rights reserved.
      </div>
    </div>
  `;

  return { htmlContent, subject };
};

module.exports = { generateMSCSEmail, generateTopUpApprovedEmail };