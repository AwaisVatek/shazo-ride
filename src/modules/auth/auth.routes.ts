import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { config } from "../../config/index";
import { db } from "../../db/index";
import { requireAuth, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { normalizePakistanPhone, isValidPakistanPhone } from "../../utils/phone";
import { sendWhatsApp, sendEmail, sendSMS } from "../../utils/notify";
import { domainNotifier } from "../../services/notification.service";

const router = Router();

/**
 * POST /api/auth/otp/send
 * Dispatches one-time verification tokens to WhatsApp or emails
 */
router.post("/otp/send", async (req: Request, res: Response) => {
  const { phone, email } = req.body;

  if (!phone && !email) {
    return sendError(res, "VALIDATION_FAILED", "Please provide a mobile phone number or an email address to dispatch the OTP.");
  }

  const useEmail = !!email && !phone;
  const target = useEmail ? email.toLowerCase().trim() : normalizePakistanPhone(phone);

  if (!useEmail && !isValidPakistanPhone(target)) {
    return sendError(res, "INVALID_PHONE", "The provided Pakistani phone number format is invalid. Ensure it conforms to +923XXXXXXXXX.");
  }

  try {
    // 1. Enforce OTP generation rate limits (60 seconds cooldown)
    const existing = await db.query(
      `SELECT created_at FROM otp_codes 
       WHERE phone = $1 AND verified_at IS NULL AND created_at > NOW() - INTERVAL '1 minute'
       ORDER BY created_at DESC LIMIT 1`,
      [target]
    );

    if (existing.length > 0) {
      return sendError(res, "COOLDOWN_ACTIVE", "An OTP was recently dispatched to this contact. Please wait 60 seconds before retrying.", 429);
    }

    // 2. Generate cryptographically safe PIN code
    const rawPin = Math.floor(1000 + Math.random() * 9000).toString(); // 4 digit code
    const salt = await bcrypt.genSalt(10);
    const pinHash = await bcrypt.hash(rawPin, salt);
    const lifeMinutes = config.OTP_EXPIRY_MINUTES;
    const expiresAt = new Date(Date.now() + lifeMinutes * 60000);

    // Save to otp_codes ledger
    const otpId = "otp_" + crypto.randomUUID().slice(0, 8);
    await db.query(
      `INSERT INTO otp_codes (id, phone, code_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [otpId, target, pinHash, expiresAt]
    );

    // 3. Dispatch OTP to the primary configuration channel
    const loginText = `Your Shazo verification security code is: *${rawPin}*. This code is valid for ${lifeMinutes} minutes. Do not share this with anyone.`;
    let activeChannel: "whatsapp" | "email" | "sms" = "whatsapp";
    let fallbackUsed = false;

    if (useEmail) {
      activeChannel = "email";
      const htmlBody = `<h3>Shazo Verification Code</h3><p>Your OTP code is: <b>${rawPin}</b></p><p>This is valid for ${lifeMinutes} minutes.</p>`;
      await sendEmail(target, "Shazo Verification OTP", htmlBody);
    } else {
      // Primary: WhatsApp via Evolution
      if (config.OTP_PRIMARY_CHANNEL === "whatsapp") {
        const waResult = await sendWhatsApp(target, loginText);
        if (!waResult.success) {
          fallbackUsed = true;
          activeChannel = config.OTP_FALLBACK_CHANNEL;
          if (activeChannel === "email") {
            const userEmail = `${target.replace("+", "")}@shazo.com`;
            await sendEmail(userEmail, "Shazo Fallback OTP Verify", `Your code is: <b>${rawPin}</b>`);
          } else if (config.OTP_ENABLE_SMS_FALLBACK) {
            await sendSMS(target, loginText);
          } else {
            activeChannel = "sms";
            await sendSMS(target, loginText); // Default mock sms fallback
          }
        }
      } else {
        activeChannel = "sms";
        await sendSMS(target, loginText);
      }
    }

    return sendSuccess(res, {
      channel: activeChannel,
      fallbackUsed,
      expiresInMinutes: lifeMinutes
    });

  } catch (err: any) {
    return sendError(res, "OTP_FAILED", err.message, 500);
  }
});

/**
 * POST /api/auth/otp/verify
 * Validates PIN challenge and executes lazy signup of user profiles
 */
router.post("/otp/verify", async (req: Request, res: Response) => {
  const { phone, email, code } = req.body;

  if ((!phone && !email) || !code) {
    return sendError(res, "VALIDATION_FAILED", "Please provide a code along with a phone number or email address.");
  }

  const useEmail = !!email && !phone;
  const target = useEmail ? email.toLowerCase().trim() : normalizePakistanPhone(phone);

  try {
    // 1. Fetch latest unexpired code
    const codes = await db.query(
      `SELECT * FROM otp_codes 
       WHERE phone = $1 AND verified_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [target]
    );

    if (codes.length === 0) {
      return sendError(res, "OTP_NOT_FOUND", "No active or unexpired OTP request matches this contact detail.");
    }

    const matchedOtp = codes[0];

    // Check attempt brute-forcing limits
    if (matchedOtp.attempts >= config.OTP_MAX_ATTEMPTS) {
      return sendError(res, "BLOCKED_ATTEMPTS", "Maximum code input attempts exceeded. Please generate a new OTP pin.", 403);
    }

    // Compare bcrypt hashing challenge pins
    const isValid = await bcrypt.compare(code, matchedOtp.code_hash);

    if (!isValid) {
      // Increment attempt counter row
      await db.query("UPDATE otp_codes SET attempts = attempts + 1, updated_at = NOW() WHERE id = $1", [matchedOtp.id]);
      return sendError(res, "WRONG_CODE", "The verification pin you provided is incorrect.", 400);
    }

    // Code verified - Consume and mark verified in database
    await db.query("UPDATE otp_codes SET verified_at = NOW(), updated_at = NOW() WHERE id = $1", [matchedOtp.id]);

    // 2. Fetch User profile or register a lazy user on the fly
    let userRows = await db.query("SELECT * FROM users WHERE phone = $1 OR email = $2", [target, target]);
    let activeUser;

    if (userRows.length === 0) {
      // Lazy SignUp
      const newId = "usr_" + crypto.randomUUID().slice(0, 8);
      const isEmailAccount = useEmail;
      const parsedName = isEmailAccount ? target.split("@")[0] : `Karachi Pilot ${target.slice(-4)}`;
      const parsedMail = isEmailAccount ? target : `${target.replace("+", "")}@shazo-otp.com`;
      const parsedPhone = isEmailAccount ? null : target;

      await db.query(
        `INSERT INTO users (id, full_name, email, phone, role, is_verified, avatar_url)
         VALUES ($1, $2, $3, $4, 'customer', true, $5)`,
        [newId, parsedName, parsedMail, parsedPhone, `https://api.dicebear.com/7.x/initials/svg?seed=${parsedName}`]
      );

      // Create linked authorization account reference row
      await db.query(
        `INSERT INTO auth_accounts (id, user_id, provider, provider_user_id)
         VALUES ($1, $2, $3, $4)`,
        ["auth_" + crypto.randomUUID().slice(0, 8), newId, isEmailAccount ? "email" : "phone_otp", target]
      );

      // Fetch newly created profile
      const freshlyCreated = await db.query("SELECT * FROM users WHERE id = $1", [newId]);
      activeUser = freshlyCreated[0];

      // Add to customer_profiles table automatically
      await db.query("INSERT INTO customer_profiles (user_id) VALUES ($1)", [newId]);
    } else {
      activeUser = userRows[0];
    }

    // 3. Encode session credentials into standard JWT claims
    const token = jwt.sign(
      { userId: activeUser.id, email: activeUser.email, role: activeUser.role },
      config.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // Persist new session row
    const sessionId = "ses_" + crypto.randomUUID().slice(0, 8);
    const sessionExpiry = new Date(Date.now() + 7 * 24 * 3600000); // 7 Days
    await db.query(
      `INSERT INTO sessions (id, user_id, role, token, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, activeUser.id, activeUser.role, token, sessionExpiry]
    );

    return sendSuccess(res, {
      token,
      user: {
        id: activeUser.id,
        full_name: activeUser.full_name,
        email: activeUser.email,
        phone: activeUser.phone,
        role: activeUser.role,
        avatar_url: activeUser.avatar_url
      }
    });

  } catch (err: any) {
    return sendError(res, "VERIFICATION_ERROR", err.message, 500);
  }
});

/**
 * POST /api/auth/email/signup
 * Registers direct credentials with standard email routes
 */
router.post("/email/signup", async (req: Request, res: Response) => {
  const { full_name, email, password, phone } = req.body;

  if (!full_name || !email || !password) {
    return sendError(res, "VALIDATION_FAILED", "Please provide a name, email address, and stable password.");
  }

  try {
    const existing = await db.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase().trim()]);
    if (existing.length > 0) {
      return sendError(res, "CONFLICT", "An account matching this email address is already registered.", 409);
    }

    const phoneChecked = phone ? normalizePakistanPhone(phone) : null;
    const cryptPassword = await bcrypt.hash(password, 10);
    const userId = "usr_" + crypto.randomUUID().slice(0, 8);

    await db.query(
      `INSERT INTO users (id, full_name, email, phone, role, is_verified, password_hash, avatar_url)
       VALUES ($1, $2, $3, $4, 'customer', true, $5, $6)`,
      [userId, full_name, email.toLowerCase().trim(), phoneChecked, cryptPassword, `https://api.dicebear.com/7.x/initials/svg?seed=${full_name}`]
    );

    await db.query(
      `INSERT INTO auth_accounts (id, user_id, provider, provider_user_id)
       VALUES ($1, $2, 'email', $3)`,
      ["auth_" + crypto.randomUUID().slice(0, 8), userId, email.toLowerCase().trim()]
    );

    await db.query("INSERT INTO customer_profiles (user_id) VALUES ($1)", [userId]);

    return sendSuccess(res, {
      message: "Registration completed successfully. Welcome to Shazo!",
      userId
    }, 201);

  } catch (err: any) {
    return sendError(res, "SIGNUP_FAILED", err.message, 500);
  }
});

/**
 * POST /api/auth/email/login
 * Standard email-password login routing
 */
router.post("/email/login", async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return sendError(res, "VALIDATION_FAILED", "Both email and password are required.");
  }

  try {
    const userRows = await db.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase().trim()]);
    if (userRows.length === 0) {
      return sendError(res, "INVALID_CREDENTIALS", "Incorrect email address or password.", 401);
    }

    const matchedUser = userRows[0];
    if (!matchedUser.password_hash) {
      return sendError(res, "OAUTH_ONLY_ACCOUNT", "This account is configured for mobile OTP or social logins. Please login accordingly.", 403);
    }

    const isValid = await bcrypt.compare(password, matchedUser.password_hash);
    if (!isValid) {
      return sendError(res, "INVALID_CREDENTIALS", "Incorrect email address or password.", 401);
    }

    const token = jwt.sign(
      { userId: matchedUser.id, email: matchedUser.email, role: matchedUser.role },
      config.JWT_SECRET,
      { expiresIn: "7d" }
    );

    const sessionId = "ses_" + crypto.randomUUID().slice(0, 8);
    const sessionExpiry = new Date(Date.now() + 7 * 24 * 3600000);
    await db.query(
      `INSERT INTO sessions (id, user_id, role, token, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, matchedUser.id, matchedUser.role, token, sessionExpiry]
    );

    return sendSuccess(res, {
      token,
      user: {
        id: matchedUser.id,
        full_name: matchedUser.full_name,
        email: matchedUser.email,
        phone: matchedUser.phone,
        role: matchedUser.role,
        avatar_url: matchedUser.avatar_url
      }
    });

  } catch (err: any) {
    return sendError(res, "LOGIN_FAILED", err.message, 500);
  }
});

/**
 * POST /api/auth/logout
 * Deletes current session JWT representation from matching indexes
 */
router.post("/logout", requireAuth, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    await db.query("DELETE FROM sessions WHERE token = $1", [authReq.session_token]);
    return sendSuccess(res, { message: "Successfully logged out from current active terminal." });
  } catch (err: any) {
    return sendError(res, "LOGOUT_FAILED", err.message, 500);
  }
});

/**
 * GET /api/auth/session
 * Pulls current session user structures
 */
router.get("/session", requireAuth, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  return sendSuccess(res, { user: authReq.user });
});

/**
 * POST /api/auth/request-otp
 * Mobile app endpoint for sending OTP to Customers and Riders
 */
router.post("/request-otp", async (req: Request, res: Response) => {
  const { phone, role } = req.body;

  if (!phone || !role || !["customer", "rider"].includes(role)) {
    return sendError(res, "VALIDATION_FAILED", "Valid phone and role (customer or rider) are required.");
  }

  const target = normalizePakistanPhone(phone);
  if (!isValidPakistanPhone(target)) {
    return sendError(res, "INVALID_PHONE", "Phone number must be a valid Pakistani number.");
  }

  try {
    // Check cooldown
    const existing = await db.query(
      `SELECT created_at FROM otp_verifications 
       WHERE normalized_phone = $1 AND role = $2 AND verified_at IS NULL AND created_at > NOW() - INTERVAL '1 second' * $3
       ORDER BY created_at DESC LIMIT 1`,
      [target, role, config.OTP_RESEND_COOLDOWN_SECONDS]
    );

    if (existing.length > 0) {
      return sendError(res, "COOLDOWN_ACTIVE", `Please wait ${config.OTP_RESEND_COOLDOWN_SECONDS} seconds before requesting a new OTP.`, 429);
    }

    // Generate OTP
    let rawPin = config.OTP_TEST_CODE;
    if (!config.OTP_BYPASS_ENABLED) {
      rawPin = Math.floor(Math.pow(10, config.OTP_CODE_LENGTH - 1) + Math.random() * 9 * Math.pow(10, config.OTP_CODE_LENGTH - 1)).toString();
    }

    const salt = await bcrypt.genSalt(10);
    const pinHash = await bcrypt.hash(rawPin, salt);
    const expiresAt = new Date(Date.now() + config.OTP_EXPIRY_MINUTES * 60000);
    const otpId = "vfn_" + crypto.randomUUID().slice(0, 8);

    await db.query(
      `INSERT INTO otp_verifications (id, phone, normalized_phone, role, otp_hash, max_attempts, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [otpId, phone, target, role, pinHash, config.OTP_MAX_ATTEMPTS, expiresAt]
    );

    // Send OTP
    if (!config.OTP_BYPASS_ENABLED) {
      await domainNotifier.dispatch(target, "otp", { otp: rawPin });
    } else {
      console.log(`[OTP_BYPASS] OTP for ${target} is ${rawPin}`);
    }

    return sendSuccess(res, {
      message: "OTP sent successfully",
      expiresInMinutes: config.OTP_EXPIRY_MINUTES,
      bypass: config.OTP_BYPASS_ENABLED
    });

  } catch (err: any) {
    return sendError(res, "OTP_FAILED", err.message, 500);
  }
});

/**
 * POST /api/auth/verify-otp
 * Mobile app endpoint for verifying OTP and generating JWT
 */
router.post("/verify-otp", async (req: Request, res: Response) => {
  const { phone, otp, role } = req.body;

  if (!phone || !otp || !role || !["customer", "rider"].includes(role)) {
    return sendError(res, "VALIDATION_FAILED", "Phone, otp, and valid role are required.");
  }

  const target = normalizePakistanPhone(phone);

  try {
    const records = await db.query(
      `SELECT * FROM otp_verifications 
       WHERE normalized_phone = $1 AND role = $2 AND verified_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [target, role]
    );

    if (records.length === 0) {
      return sendError(res, "OTP_NOT_FOUND", "No active OTP found or OTP has expired.");
    }

    const matchedOtp = records[0];

    if (matchedOtp.attempts >= matchedOtp.max_attempts) {
      return sendError(res, "BLOCKED_ATTEMPTS", "Maximum attempts exceeded. Request a new OTP.", 403);
    }

    const isValid = await bcrypt.compare(otp.toString(), matchedOtp.otp_hash);

    if (!isValid) {
      await db.query("UPDATE otp_verifications SET attempts = attempts + 1, updated_at = NOW() WHERE id = $1", [matchedOtp.id]);
      return sendError(res, "WRONG_CODE", "The OTP provided is incorrect.", 400);
    }

    await db.query("UPDATE otp_verifications SET verified_at = NOW(), updated_at = NOW() WHERE id = $1", [matchedOtp.id]);

    // Handle Lazy Registration
    let userRows = await db.query("SELECT * FROM users WHERE phone = $1 AND role = $2", [target, role]);
    let activeUser;
    let isNewUser = false;

    if (userRows.length === 0) {
      isNewUser = true;
      const newId = "usr_" + crypto.randomUUID().slice(0, 8);
      const parsedName = `${role === 'customer' ? 'Customer' : 'Rider'} ${target.slice(-4)}`;

      await db.query(
        `INSERT INTO users (id, full_name, phone, role, is_verified, avatar_url)
         VALUES ($1, $2, $3, $4, true, $5)`,
        [newId, parsedName, target, role, `https://api.dicebear.com/7.x/initials/svg?seed=${parsedName}`]
      );

      await db.query(
        `INSERT INTO auth_accounts (id, user_id, provider, provider_user_id)
         VALUES ($1, $2, 'phone_otp', $3)`,
        ["auth_" + crypto.randomUUID().slice(0, 8), newId, target]
      );

      if (role === "customer") {
        await db.query("INSERT INTO customer_profiles (user_id) VALUES ($1)", [newId]);
      } else if (role === "rider") {
        await db.query("INSERT INTO rider_profiles (user_id) VALUES ($1)", [newId]);
        await db.query("INSERT INTO rider_wallets (rider_id, balance) VALUES ($1, 0)", [newId]);
      }

      const freshlyCreated = await db.query("SELECT * FROM users WHERE id = $1", [newId]);
      activeUser = freshlyCreated[0];
    } else {
      activeUser = userRows[0];
    }

    const token = jwt.sign(
      { userId: activeUser.id, role: activeUser.role },
      config.JWT_SECRET,
      { expiresIn: "30d" }
    );

    const sessionId = "ses_" + crypto.randomUUID().slice(0, 8);
    await db.query(
      `INSERT INTO sessions (id, user_id, role, token, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, activeUser.id, activeUser.role, token, new Date(Date.now() + 30 * 24 * 3600000)]
    );

    return sendSuccess(res, {
      token,
      user: {
        id: activeUser.id,
        phone: activeUser.phone,
        role: activeUser.role,
        profile_completed: activeUser.profile_completed || false,
        isNewUser
      }
    });

  } catch (err: any) {
    return sendError(res, "VERIFICATION_ERROR", err.message, 500);
  }
});

/**
 * GET /api/auth/me
 * Mobile app endpoint to get authenticated user session
 */
router.get("/me", requireAuth, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const userRows = await db.query("SELECT id, full_name, phone, role, profile_completed, avatar_url FROM users WHERE id = $1", [authReq.user.userId]);
  
  if (userRows.length === 0) {
    return sendError(res, "USER_NOT_FOUND", "Authenticated user not found.", 404);
  }

  return sendSuccess(res, { user: userRows[0] });
});

export default router;
