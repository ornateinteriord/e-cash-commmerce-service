const nodemailer = require("nodemailer");
require("dotenv").config();

let transporter = null;

const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  }
  return transporter;
};



const sendMail = async (email, subject, htmlContent, textContent = '', attachments = []) => {
  try {
    const mailOptions = {
      from: `"E shopy" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: subject,
      html: htmlContent,
      text: textContent || 'Please view this email in an HTML compatible client.',
      ...(attachments.length > 0 && { attachments })
    };

    const info = await getTransporter().sendMail(mailOptions);
    return info;

  } catch (error) {
    console.error("Error sending email:", error);
    throw error;
  }
}

module.exports = { sendMail };