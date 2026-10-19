import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Creates and returns a Nodemailer transporter configured with environment variables.
 * @returns {nodemailer.Transporter}
 */
export const createTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true', // true for port 465, false for others
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
};

/**
 * Sends a dynamic alert email to the project manager configured in the project config.
 * 
 * @param {Object} params
 * @param {Object} params.projectConfig - Configuration object containing projectManagerEmail and projectName
 * @param {string} params.subject - Subject line for the alert email
 * @param {string} [params.text] - Plain text content of the alert
 * @param {string} [params.html] - HTML content of the alert
 * @returns {Promise<nodemailer.SentMessageInfo>}
 */
export const sendProjectAlert = async ({ projectConfig, subject, text, html }) => {
  const recipient = projectConfig?.projectManagerEmail;

  if (!recipient) {
    throw new Error('Project manager email is missing in the provided project configuration.');
  }

  const projectName = projectConfig.projectName || 'Generic Project';
  const fullSubject = `[${projectName} Alert] ${subject}`;

  const transporter = createTransporter();

  const mailOptions = {
    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@smart-project-agent.local',
    to: recipient,
    subject: fullSubject,
    text: text || html?.replace(/<[^>]*>?/gm, '') || 'No details provided.',
    html: html || `<p>${text || 'No details provided.'}</p>`,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[Mailer] Alert sent successfully to ${recipient} (Message ID: ${info.messageId})`);
    return info;
  } catch (error) {
    console.error(`[Mailer] Failed to send alert email to ${recipient}:`, error.message);
    throw error;
  }
};

export default {
  createTransporter,
  sendProjectAlert,
};
