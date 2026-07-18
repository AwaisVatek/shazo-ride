import dotenv from "dotenv";
import { z } from "zod";

// Load active environment variables
dotenv.config();

const configSchema = z.object({
  APP_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.preprocess((val) => Number(val) || 3000, z.number()),
  APP_BASE_URL: z.string().default("https://app.shazoride.com"),
  API_BASE_URL: z.string().default("https://app.shazoride.com"),

  // Database Connection
  DATABASE_URL: z.string().default("postgresql://postgres:postgres@localhost:5432/shazoride"),

  // Authentication Secrets
  JWT_SECRET: z.string().default("shazo-super-secret-jwt-key-2026-karachi"),
  SESSION_SECRET: z.string().default("shazo-session-aes-token-encryption-21441"),

  // Region & Platform Defaults
  DEFAULT_COUNTRY_CODE: z.preprocess((val) => String(val), z.string().default("92")),
  DEFAULT_CITY: z.string().default("Karachi"),
  DEFAULT_CURRENCY: z.string().default("PKR"),

  // OTP Configuration Setup
  OTP_PROVIDER: z.string().default("n8n_webhook"),
  OTP_PRIMARY_CHANNEL: z.enum(["whatsapp", "email", "sms"]).default("whatsapp"),
  OTP_FALLBACK_CHANNEL: z.enum(["whatsapp", "email", "sms"]).default("email"),
  OTP_ENABLE_SMS_FALLBACK: z.preprocess((val) => val === "true", z.boolean().default(false)),
  OTP_CODE_LENGTH: z.preprocess((val) => Number(val) || 6, z.number().default(6)),
  OTP_EXPIRY_MINUTES: z.preprocess((val) => Number(val) || 5, z.number().default(5)),
  OTP_MAX_ATTEMPTS: z.preprocess((val) => Number(val) || 5, z.number().default(5)),
  OTP_RESEND_COOLDOWN_SECONDS: z.preprocess((val) => Number(val) || 60, z.number().default(60)),
  OTP_BYPASS_ENABLED: z.preprocess((val) => val === "true" || val === true || val === undefined, z.boolean().default(true)),
  OTP_TEST_CODE: z.string().default("123456"),
  CUSTOMER_TEST_LOGIN_ENABLED: z.preprocess((val) => val === "true" || val === undefined, z.boolean().default(true)),
  CUSTOMER_TEST_PHONE: z.string().default("923183765294"),
  CUSTOMER_TEST_OTP: z.string().default("123456"),
  N8N_OTP_WEBHOOK_URL: z.string().default("https://n8n.visioninfinity.co/webhook/shazo-otp"),
  N8N_OTP_WEBHOOK_SECRET: z.string().default("shazo_secret_2026"),

  // Evolution WhatsApp Gateway API
  WHATSAPP_PROVIDER: z.string().default("evolution"),
  EVOLUTION_API_URL: z.string().default("http://evo-kdq65p6ztxy3655q2y1iafko.144.91.76.234.sslip.io"),
  EVOLUTION_API_KEY: z.string().default("demo_instance_key"),
  EVOLUTION_GLOBAL_API_KEY: z.string().default("demo_global_key"),
  EVOLUTION_INSTANCE_ID: z.string().default("demo_instance_id"),
  EVOLUTION_INSTANCE_NAME: z.string().default("shazo_ride"),
  EVOLUTION_WEBHOOK_URL: z.string().default("https://app.shazoride.com/api/webhooks/evolution"),
  EVOLUTION_DEFAULT_COUNTRY_CODE: z.string().default("92"),

  // Brevo/SMTP Mailer Setup
  EMAIL_PROVIDER: z.string().default("smtp"),
  EMAIL_FROM: z.string().default("hello@shazoride.com"),
  EMAIL_FROM_NAME: z.string().default("Shazo Ride"),
  SMTP_HOST: z.string().default("smtp-relay.brevo.com"),
  SMTP_PORT: z.preprocess((val) => Number(val) || 587, z.number().default(587)),
  SMTP_USER: z.string().default("demo_smtp_user"),
  SMTP_PASS: z.string().default("demo_smtp_password"),

  // SMS Gateway Provider Setup (Default Mock)
  SMS_PROVIDER: z.string().default("mock"),
  SMS_API_KEY: z.string().default("demo_sms_api_key"),
  SMS_SENDER_ID: z.string().default("SHAZO"),

  // Financial Mechanics
  PAYMENT_MODE: z.enum(["manual", "automatic"]).default("manual"),
  MANUAL_PAYMENT_ENABLED: z.preprocess((val) => val === "true" || val === undefined, z.boolean().default(true)),
  ONLINE_PAYMENT_ENABLED: z.preprocess((val) => val === "true", z.boolean().default(false)),

  // Commisison launch rules
  FREE_COMMISSION_ENABLED: z.preprocess((val) => val === "true" || val === undefined, z.boolean().default(true)),
  FREE_COMMISSION_START_DATE: z.string().default("2026-06-01"),
  FREE_COMMISSION_END_DATE: z.string().default("2026-12-31"),

  // Maps provider — Mapbox is the platform's only maps/geocoding provider (no Google Maps).
  MAPS_PROVIDER: z.string().default("mapbox"),
  MAPBOX_API_KEY: z.string().default("demo_mapbox_secret_key"),

  // Demo Sandbox rules
  ENABLE_DEMO_CREDENTIALS: z.preprocess((val) => val !== "false", z.boolean().default(true)),
  ENABLE_API_MONITOR: z.preprocess((val) => val !== "false", z.boolean().default(true)),
});

// Safely parse env configuration
const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configurations:", JSON.stringify(parsed.error.format(), null, 2));
  if (process.env.NODE_ENV === "production") {
    process.exit(1);
  }
}

export const config = parsed.success ? parsed.data : configSchema.parse({});
