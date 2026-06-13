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
    const list = await db.query(
      `SELECT m.*, u.full_name as rider_name, u.phone as rider_phone 
       FROM manual_topup_requests m
       JOIN users u ON m.rider_id = u.id
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
    // 1. Fetch Request details
    const requests = await db.query("SELECT * FROM manual_topup_requests WHERE id = $1", [requestId]);
    if (requests.length === 0) {
      return sendError(res, "REQUEST_NOT_FOUND", "Top-up filing record missing.", 404);
    }

    const tr = requests[0];
    if (tr.status !== "pending") {
      return sendError(res, "ALREADY_PROCESSED", `This request was already completed with state: '${tr.status}'.`, 400);
    }

    if (status === "approved") {
      // 2. Perform double-entry financial ledger insertions inside transaction block
      await db.transaction(async (client) => {
        // Increment rider balance
        await client.query(
          "UPDATE rider_wallets SET balance = balance + $1, updated_at = NOW() WHERE rider_id = $2",
          [Number(tr.amount), tr.rider_id]
        );

        // Record credit line ledger logging
        const ledgerId = "ledg_" + crypto.randomUUID().slice(0, 8);
        await client.query(
          `INSERT INTO rider_wallet_ledger (id, rider_id, amount, transaction_type, reference_id, note)
           VALUES ($1, $2, $3, 'manual_topup', $4, $5)`,
          [ledgerId, tr.rider_id, Number(tr.amount), requestId, note || `Manual top-up approved via fin-desk. Reference ID: ${tr.transaction_id}`]
        );

        // Update request filing status
        await client.query(
          `UPDATE manual_topup_requests 
           SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(), note = COALESCE($2, note)
           WHERE id = $3`,
          [req.user!.id, note || null, requestId]
        );
      });
    } else {
      // Rejecting filing
      await db.query(
        `UPDATE manual_topup_requests 
         SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), rejection_reason = $2, note = COALESCE($3, note)
         WHERE id = $4`,
        [req.user!.id, rejection_reason || "Verification details unmatched.", note || null, requestId]
      );
    }

    const finalModel = await db.query("SELECT * FROM manual_topup_requests WHERE id = $1", [requestId]);

    return sendSuccess(res, {
      request: finalModel[0],
      message: `Top-up filing resolved as: '${status}' successfully.`
    });

  } catch (err: any) {
    return sendError(res, "RESOLVE_TOPUP_FAILED", err.message, 500);
  }
});

export default router;
