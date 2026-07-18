import { Router, Request, Response } from "express";
import crypto from "crypto";
import { requireAuth, requireFinanceAdmin, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { db } from "../../db/index";

const router = Router();

router.use(requireAuth, requireFinanceAdmin);

/**
 * GET /api/finance/topups
 * Lists manual payment top-up requests filed by drivers
 */
router.get("/topups", async (req: Request, res: Response) => {
  try {
    // m.rider_id is rider_profiles.id, not users.id — join through the profile
    // first (an INNER join straight to users on this column always returned
    // zero rows, since the id spaces never match).
    const list = await db.query(
      `SELECT m.*, u.full_name as rider_name, u.phone as rider_phone
       FROM manual_topup_requests m
       LEFT JOIN rider_profiles rp ON rp.id = m.rider_id
       LEFT JOIN users u ON u.id = rp.user_id
       ORDER BY m.created_at DESC`
    );

    return sendSuccess(res, { requests: list });
  } catch (err: any) {
    return sendError(res, "FETCH_TOPUPS_FAILED", err.message, 500);
  }
});

/**
 * PATCH /api/finance/topups/:id
 * Approves or rejects manual payment filings and updates pilot wallet balances on approval
 */
router.patch("/topups/:id", async (req: AuthenticatedRequest, res: Response) => {
  const requestId = req.params.id;
  const { status, note, rejection_reason } = req.body;

  if (!["approved", "rejected"].includes(status)) {
    return sendError(res, "VALIDATION_FAILED", "Invalid top-up review status. Allowed: 'approved', 'rejected'.");
  }

  try {
    if (status === "approved") {
      // Atomic guard: claim the request only if it's still 'pending' — the SELECT-then-
      // UPDATE this replaced could let two concurrent requests both pass the pending
      // check and double-credit the wallet.
      const claimed = await db.query(
        "UPDATE manual_topup_requests SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(), note = COALESCE($2, note) WHERE id = $3 AND status = 'pending' RETURNING *",
        [req.user!.id, note || null, requestId]
      );
      if (claimed.length === 0) {
        const existing = await db.query("SELECT status FROM manual_topup_requests WHERE id = $1", [requestId]);
        if (existing.length === 0) return sendError(res, "REQUEST_NOT_FOUND", "Top-up filing record missing.", 404);
        return sendError(res, "ALREADY_PROCESSED", `This request was already completed with state: '${existing[0].status}'.`, 400);
      }

      const tr = claimed[0];
      const ledgerId = "ledg_" + crypto.randomUUID().slice(0, 8);
      await db.transaction(async (client) => {
        await client.query(
          "UPDATE rider_wallets SET balance = balance + $1, updated_at = NOW() WHERE rider_id = $2",
          [Number(tr.amount), tr.rider_id]
        );
        await client.query(
          `INSERT INTO rider_wallet_ledger (id, rider_id, amount, transaction_type, reference_id, note)
           VALUES ($1, $2, $3, 'manual_topup', $4, $5)`,
          [ledgerId, tr.rider_id, Number(tr.amount), requestId, note || `Manual top-up approved via fin-desk. Reference ID: ${tr.transaction_id}`]
        );
      });

      const finalModel = await db.query("SELECT * FROM manual_topup_requests WHERE id = $1", [requestId]);
      return sendSuccess(res, { request: finalModel[0], message: "Top-up filing resolved as: 'approved' successfully." });
    }

    // Rejecting filing — same atomic guard, no wallet mutation involved.
    const claimed = await db.query(
      `UPDATE manual_topup_requests
       SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), rejection_reason = $2, note = COALESCE($3, note)
       WHERE id = $4 AND status = 'pending' RETURNING *`,
      [req.user!.id, rejection_reason || "Verification details unmatched.", note || null, requestId]
    );
    if (claimed.length === 0) {
      const existing = await db.query("SELECT status FROM manual_topup_requests WHERE id = $1", [requestId]);
      if (existing.length === 0) return sendError(res, "REQUEST_NOT_FOUND", "Top-up filing record missing.", 404);
      return sendError(res, "ALREADY_PROCESSED", `This request was already completed with state: '${existing[0].status}'.`, 400);
    }

    return sendSuccess(res, { request: claimed[0], message: "Top-up filing resolved as: 'rejected' successfully." });

  } catch (err: any) {
    return sendError(res, "RESOLVE_TOPUP_FAILED", err.message, 500);
  }
});

/**
 * GET /api/finance/customer-topups
 * Lists manual wallet top-up requests filed by customers
 */
router.get("/customer-topups", async (req: Request, res: Response) => {
  try {
    const list = await db.query(
      `SELECT m.*, u.full_name as customer_name, u.phone as customer_phone
       FROM customer_manual_topup_requests m
       JOIN users u ON m.customer_id = u.id
       ORDER BY m.created_at DESC`
    );
    return sendSuccess(res, { requests: list });
  } catch (err: any) {
    return sendError(res, "FETCH_CUSTOMER_TOPUPS_FAILED", err.message, 500);
  }
});

/**
 * PATCH /api/finance/customer-topups/:id
 * Approves or rejects manual customer wallet top-up filings
 */
router.patch("/customer-topups/:id", async (req: AuthenticatedRequest, res: Response) => {
  const requestId = req.params.id;
  const { status, note, rejection_reason } = req.body;

  if (!["approved", "rejected"].includes(status)) {
    return sendError(res, "VALIDATION_FAILED", "Invalid top-up review status. Allowed: 'approved', 'rejected'.");
  }

  try {
    if (status === "approved") {
      const claimed = await db.query(
        "UPDATE customer_manual_topup_requests SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(), notes = COALESCE($2, notes) WHERE id = $3 AND status = 'pending' RETURNING *",
        [req.user!.id, note || null, requestId]
      );
      if (claimed.length === 0) {
        const existing = await db.query("SELECT status FROM customer_manual_topup_requests WHERE id = $1", [requestId]);
        if (existing.length === 0) return sendError(res, "REQUEST_NOT_FOUND", "Top-up filing record missing.", 404);
        return sendError(res, "ALREADY_PROCESSED", `This request was already completed with state: '${existing[0].status}'.`, 400);
      }

      const tr = claimed[0];
      const ledgerId = "cledg_" + crypto.randomUUID().slice(0, 8);
      await db.transaction(async (client) => {
        await client.query(
          `INSERT INTO customer_wallets (id, customer_id, balance)
           VALUES ($1, $2, $3)
           ON CONFLICT (customer_id) DO UPDATE SET balance = customer_wallets.balance + EXCLUDED.balance, updated_at = NOW()`,
          ["cwal_" + crypto.randomUUID().slice(0, 8), tr.customer_id, Number(tr.amount)]
        );
        await client.query(
          `INSERT INTO customer_wallet_ledger (id, customer_id, amount, transaction_type, reference_id, note)
           VALUES ($1, $2, $3, 'manual_topup', $4, $5)`,
          [ledgerId, tr.customer_id, Number(tr.amount), requestId, note || `Manual top-up approved via fin-desk. Reference ID: ${tr.transaction_id}`]
        );
      });

      const finalModel = await db.query("SELECT * FROM customer_manual_topup_requests WHERE id = $1", [requestId]);
      return sendSuccess(res, { request: finalModel[0], message: "Top-up filing resolved as: 'approved' successfully." });
    }

    const claimed = await db.query(
      `UPDATE customer_manual_topup_requests
       SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), rejection_reason = $2, notes = COALESCE($3, notes)
       WHERE id = $4 AND status = 'pending' RETURNING *`,
      [req.user!.id, rejection_reason || "Verification details unmatched.", note || null, requestId]
    );
    if (claimed.length === 0) {
      const existing = await db.query("SELECT status FROM customer_manual_topup_requests WHERE id = $1", [requestId]);
      if (existing.length === 0) return sendError(res, "REQUEST_NOT_FOUND", "Top-up filing record missing.", 404);
      return sendError(res, "ALREADY_PROCESSED", `This request was already completed with state: '${existing[0].status}'.`, 400);
    }

    return sendSuccess(res, { request: claimed[0], message: "Top-up filing resolved as: 'rejected' successfully." });

  } catch (err: any) {
    return sendError(res, "RESOLVE_CUSTOMER_TOPUP_FAILED", err.message, 500);
  }
});

export default router;
