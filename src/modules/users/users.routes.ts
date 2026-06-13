import { Router, Response } from "express";
import { requireAuth, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { normalizePakistanPhone } from "../../utils/phone";
import { db } from "../../db/index";

const router = Router();

/**
 * GET /api/users/me
 * Retrieves full details of the authenticated user
 */
router.get("/me", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const users = await db.query(
      `SELECT id, full_name, email, phone, role, avatar_url, is_verified, created_at 
       FROM users WHERE id = $1`,
      [req.user!.id]
    );

    if (users.length === 0) {
      return sendError(res, "USER_NOT_FOUND", "Profile could not be resolved from active database.", 404);
    }

    return sendSuccess(res, { user: users[0] });
  } catch (err: any) {
    return sendError(res, "FETCH_ME_FAILED", err.message, 500);
  }
});

/**
 * PATCH /api/users/me
 * Updates editable profile attributes, blocking unauthorized self-role escalations
 */
router.patch("/me", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { full_name, phone, avatar_url, role } = req.body;

  try {
    // 1. Defend role escalation blocks
    if (role && role !== req.user!.role) {
      if (req.user!.role !== "admin") {
        return sendError(res, "FORBIDDEN", "Unauthorized action. Self-role escalations are prohibited.", 403);
      }
    }

    // 2. Format variables
    const finalPhone = phone ? normalizePakistanPhone(phone) : undefined;

    // Check phone conflicts
    if (finalPhone) {
      const conflicts = await db.query("SELECT id FROM users WHERE phone = $1 AND id != $2", [finalPhone, req.user!.id]);
      if (conflicts.length > 0) {
        return sendError(res, "CONFLICT", "This phone number is already bound to another registered account.", 409);
      }
    }

    // 3. Perform dynamic SQL updates
    await db.query(
      `UPDATE users 
       SET full_name = COALESCE($1, full_name),
           phone = COALESCE($2, phone),
           avatar_url = COALESCE($3, avatar_url),
           role = COALESCE($4, role),
           updated_at = NOW()
       WHERE id = $5`,
      [full_name || null, finalPhone || null, avatar_url || null, role || null, req.user!.id]
    );

    // Fetch the updated model
    const users = await db.query(
      `SELECT id, full_name, email, phone, role, avatar_url, is_verified, updated_at 
       FROM users WHERE id = $1`,
      [req.user!.id]
    );

    return sendSuccess(res, { user: users[0] });

  } catch (err: any) {
    return sendError(res, "UPDATE_PROFILE_FAILED", err.message, 500);
  }
});

export default router;
