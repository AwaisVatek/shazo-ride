import nodemailer from "nodemailer";
import { config } from "../config/index";
import { db } from "../db/index";
import crypto from "crypto";

export interface SendResult {
  success: boolean;
  channel: "whatsapp" | "email" | "sms";
  provider: string;
  externalId?: string;
  error?: string;
}

class NotificationService {
  private transporter: nodemailer.Transporter | null = null;

  /**
   * Lazily initializes and caches SMTP Nodemailer Transporter
   */
  private getTransporter() {
    if (this.transporter) return this.transporter;

    if (config.SMTP_USER && config.SMTP_USER !== "demo_smtp_user" && config.SMTP_HOST) {
      this.transporter = nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: Number(config.SMTP_PORT),
        secure: Number(config.SMTP_PORT) === 465, // true for 465 (SMTPS), false for others
        auth: {
          user: config.SMTP_USER,
          pass: config.SMTP_PASS,
        },
      });
    }
    return this.transporter;
  }

  /**
   * Log transaction state in the otp_delivery_logs table
   */
  private async logDelivery(
    phone_or_email: string,
    channel: "whatsapp" | "email" | "sms",
    provider: string,
    status: "sent" | "failed",
    externalId?: string,
    error?: string
  ): Promise<void> {
    try {
      const logId = "log_" + crypto.randomUUID().slice(0, 8);
      await db.query(
        `INSERT INTO otp_delivery_logs (id, phone, channel, provider, status, external_id, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [logId, phone_or_email, channel, provider, status, externalId || null, error || null]
      );
    } catch (err: any) {
      console.error("⚠️ Failed compiling otp_delivery_logs entry:", err.message);
    }
  }

  /**
   * Dispatches WhatsApp alerts via the Evolution API (Primary OTP channel)
   */
  public async sendWhatsApp(phone: string, message: string): Promise<SendResult> {
    const provider = "evolution";
    
    // Fall back to a local console log if mock or unconfigured
    if (config.EVOLUTION_API_KEY === "demo_evolution_key" || !config.EVOLUTION_API_BASE_URL) {
      console.log(`[WhatsApp Mock to ${phone}]: ${message}`);
      await this.logDelivery(phone, "whatsapp", provider, "sent", "mock_wa_" + Date.now());
      return { success: true, channel: "whatsapp", provider, externalId: "mock_wa_" + Date.now() };
    }

    try {
      // Clean non-digit characters for WhatsApp API destination
      const digitsOnly = phone.replace(/\D/g, "");
      const url = `${config.EVOLUTION_API_BASE_URL}/message/sendText/${config.EVOLUTION_INSTANCE_NAME}`;
      
      const payload = {
        number: digitsOnly,
        options: {
          delay: 1200,
          presence: "composing"
        },
        textMessage: {
          text: message
        }
      };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": config.EVOLUTION_API_KEY
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`Evolution API response code: ${response.status}`);
      }

      const resJson: any = await response.json();
      const externalId = resJson?.key?.id || "wa_ok_" + Date.now();

      await this.logDelivery(phone, "whatsapp", provider, "sent", externalId);
      return { success: true, channel: "whatsapp", provider, externalId };
    } catch (err: any) {
      console.error(`❌ Evolution WhatsApp dispatch error to ${phone}:`, err.message);
      await this.logDelivery(phone, "whatsapp", provider, "failed", undefined, err.message);
      return { success: false, channel: "whatsapp", provider, error: err.message };
    }
  }

  /**
   * Dispatches automated emails through SMTP (Secondary OTP / Fallback channel)
   */
  public async sendEmail(email: string, subject: string, htmlContent: string): Promise<SendResult> {
    const provider = "nodemailer";
    const smtpTransporter = this.getTransporter();

    // Check if nodemailer transporter is unavailable and fallback to mock
    if (!smtpTransporter) {
      console.log(`[Email Mock to ${email}] Sub: ${subject}`);
      await this.logDelivery(email, "email", "mock_nodemailer", "sent", "mock_mail_" + Date.now());
      return { success: true, channel: "email", provider: "mock_nodemailer", externalId: "mock_mail_" + Date.now() };
    }

    try {
      const mailOptions = {
        from: `"${config.EMAIL_FROM_NAME}" <${config.EMAIL_FROM}>`,
        to: email,
        subject: subject,
        html: htmlContent,
      };

      const info = await smtpTransporter.sendMail(mailOptions);
      const messageId = info.messageId || "mail_sent_" + Date.now();

      await this.logDelivery(email, "email", provider, "sent", messageId);
      return { success: true, channel: "email", provider, externalId: messageId };
    } catch (err: any) {
      console.error(`❌ Automated Nodemailer SMTP dispatch error to ${email}:`, err.message);
      await this.logDelivery(email, "email", provider, "failed", undefined, err.message);
      return { success: false, channel: "email", provider, error: err.message };
    }
  }

  /**
   * Dispatches SMS alerts (Disabled by default as per system guidelines)
   */
  public async sendSMS(phone: string, message: string): Promise<SendResult> {
    const provider = config.SMS_PROVIDER;
    const errorMsg = "SMS OTP delivery is disabled by default as per system security policy.";
    
    console.warn(`[SMS Disabled] Blocked send request to ${phone}: ${message}`);
    await this.logDelivery(phone, "sms", provider, "failed", undefined, errorMsg);
    
    return { success: false, channel: "sms", provider, error: errorMsg };
  }
}

export const notificationService = new NotificationService();
export const sendWhatsApp = notificationService.sendWhatsApp.bind(notificationService);
export const sendEmail = notificationService.sendEmail.bind(notificationService);
export const sendSMS = notificationService.sendSMS.bind(notificationService);
