import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config/index";
import { db } from "../db/index";
import { sendError } from "../utils/response";

// Extend Express Request type definitions to hold our custom context
export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    full_name: string;
    email: string;
    phone: string;
    role: string;
    is_verified: boolean;
  };
  session_token?: string;
}

/**
 * Decodes, validates and asserts the presence of a valid Bearer JWT session token
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return sendError(res, "UNAUTHORIZED", "Access denied. Bearer JWT authorization signature token is required.", 401);
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as {
      userId: string;
      email: string;
      role: string;
    };

    // 1. Cross-verify with database active sessions table
    const sessions = await db.query("SELECT * FROM sessions WHERE token = $1 AND expires_at > CURRENT_TIMESTAMP", [token]);
    if (sessions.length === 0) {
      return sendError(res, "SESSION_EXPIRED", "Your credential session is either expired, consumed, or terminated.", 401);
    }

    // 2. Hydrate complete user object context
    const users = await db.query("SELECT id, full_name, email, phone, role, is_verified FROM users WHERE id = $1", [decoded.userId]);
    if (users.length === 0) {
      return sendError(res, "USER_NOT_FOUND", "Profile details missing from secure catalog index.", 401);
    }

    const matchedUser = users[0];

    // Bind hydrated context
    (req as AuthenticatedRequest).user = {
      id: matchedUser.id,
      full_name: matchedUser.full_name,
      email: matchedUser.email,
      phone: matchedUser.phone || "",
      role: matchedUser.role,
      is_verified: !!matchedUser.is_verified,
    };
    (req as AuthenticatedRequest).session_token = token;

    next();
  } catch (err: any) {
    return sendError(res, "INVALID_TOKEN", `Verification failed: ${err.message}`, 401);
  }
}

/**
 * Validates role-level access rights dynamically
 */
export function requireRole(allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      return sendError(res, "UNAUTHORIZED", "Session context uninitialized.", 401);
    }

    const userRole = authReq.user.role.toLowerCase();
    const hasRole = allowedRoles.map(r => r.toLowerCase()).includes(userRole);

    if (!hasRole) {
      return sendError(res, "FORBIDDEN", `Access forbidden. Authorized roles: [${allowedRoles.join(", ")}]. Your role: '${authReq.user.role}'`, 403);
    }

    next();
  };
}

// Named Role Middlewares
export const requireCustomer = requireRole(["customer"]);
export const requireRider = requireRole(["rider"]);
export const requireRestaurant = requireRole(["restaurant"]);
export const requireAdmin = requireRole(["admin"]);
export const requireSupportAgent = requireRole(["support_agent", "admin"]);
export const requireFinanceAdmin = requireRole(["finance_admin", "admin"]);
export const requireOperationsManager = requireRole(["operations_manager", "admin"]);

/**
 * Asserts that a rider profile has completed physical documentation criteria checklist
 */
export async function requireVerifiedRider(req: Request, res: Response, next: NextFunction) {
  const authReq = req as AuthenticatedRequest;
  if (!authReq.user || authReq.user.role !== "rider") {
    return sendError(res, "UNAUTHORIZED", "Rider profile context unrecognized.", 401);
  }

  try {
    const profiles = await db.query("SELECT verification_status FROM rider_profiles WHERE user_id = $1", [authReq.user.id]);
    if (profiles.length === 0) {
      return sendError(res, "PROFILE_MISSING", "Rider record missing from database ledger.", 404);
    }

    const { verification_status } = profiles[0];
    if (verification_status !== "verified") {
      return sendError(res, "RIDER_UNVERIFIED", "Access denied. Your Shazo pilot registration is currently pending documentation audits.", 403);
    }

    next();
  } catch (err: any) {
    return sendError(res, "MIDDLEWARE_ERROR", err.message, 500);
  }
}

/**
 * Asserts that a restaurant outlet is active on the Shazo network
 */
export async function requireActiveRestaurant(req: Request, res: Response, next: NextFunction) {
  const authReq = req as AuthenticatedRequest;
  if (!authReq.user || authReq.user.role !== "restaurant") {
    return sendError(res, "UNAUTHORIZED", "Eatery credentials unrecognized.", 401);
  }

  try {
    const profiles = await db.query("SELECT is_active FROM restaurant_profiles WHERE owner_id = $1", [authReq.user.id]);
    if (profiles.length === 0) {
      return sendError(res, "STORE_MISSING", "No active store registration is linked to this account.", 404);
    }

    const { is_active } = profiles[0];
    if (!is_active) {
      return sendError(res, "STORE_INACTIVE", "Your Kababjees/eatery profile is marked inactive. Contact support.", 403);
    }

    next();
  } catch (err: any) {
    return sendError(res, "MIDDLEWARE_ERROR", err.message, 500);
  }
}

/**
 * Asserts that a driver/rider wallet balance complies with minimum ledger eligibility deposit criteria
 */
export async function requireWalletEligibleRider(req: Request, res: Response, next: NextFunction) {
  const authReq = req as AuthenticatedRequest;
  if (!authReq.user || authReq.user.role !== "rider") {
    return sendError(res, "UNAUTHORIZED", "Pilot profile context unrecognized.", 401);
  }

  try {
    const wallets = await db.query("SELECT balance FROM rider_wallets WHERE rider_id = $1", [authReq.user.id]);
    const balance = wallets.length > 0 ? Number(wallets[0].balance) : 0;

    // Minimum balance to accept rides on the platform is PKR -100
    if (balance < -100.00) {
      return sendError(res, "WALLET_INELIGIBLE", `Suspended. Your pilot ledger wallet has a negative balance of PKR ${balance}. Please clear your commission dues via Manual Top-Up to resume.`, 403);
    }

    next();
  } catch (err: any) {
    return sendError(res, "MIDDLEWARE_ERROR", err.message, 500);
  }
}
