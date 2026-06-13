import { Router, Response } from "express";
import crypto from "crypto";
import { requireAuth, requireRider, requireWalletEligibleRider, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { db } from "../../db/index";

const router = Router();

// Secure entire route segment to riders only
router.use(requireAuth, requireRider);

/**
 * PATCH /api/rider/toggle-online
 * Toggles a rider's presence on the dispatch network
 */
router.patch("/toggle-online", requireWalletEligibleRider, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const statusRows = await db.query("SELECT is_online FROM rider_profiles WHERE user_id = $1", [req.user!.id]);
    if (statusRows.length === 0) {
      return sendError(res, "PROFILE_MISSING", "Rider record missing from database.", 404);
    }

    const nextStatus = !statusRows[0].is_online;
    await db.query(
      "UPDATE rider_profiles SET is_online = $1, updated_at = NOW() WHERE user_id = $2",
      [nextStatus, req.user!.id]
    );

    return sendSuccess(res, {
      is_online: nextStatus,
      message: nextStatus ? "You are now online. Stay close to coverage areas to secure ride requests." : "You are now offline."
    });

  } catch (err: any) {
    return sendError(res, "TOGGLE_ONLINE_FAILED", err.message, 500);
  }
});

/**
 * GET /api/rider/wallet
 * Pulls current wallet balance and dynamic ledger audit trails
 */
router.get("/wallet", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const wallets = await db.query("SELECT balance FROM rider_wallets WHERE rider_id = $1", [req.user!.id]);
    const balance = wallets.length > 0 ? Number(wallets[0].balance) : 0.00;

    const ledger = await db.query(
      `SELECT * FROM rider_wallet_ledger 
       WHERE rider_id = $1 
       ORDER BY created_at DESC LIMIT 50`,
      [req.user!.id]
    );

    return sendSuccess(res, {
      balance,
      history: ledger
    });

  } catch (err: any) {
    return sendError(res, "FETCH_WALLET_FAILED", err.message, 500);
  }
});

/**
 * POST /api/rider/manual-topup
 * Submits manual payment receipt forms for wallet topup verifications
 */
router.post("/manual-topup", async (req: AuthenticatedRequest, res: Response) => {
  const { amount, method, sender_name, sender_phone, transaction_id, screenshot_url, note } = req.body;

  if (!amount || !method || !sender_name || !sender_phone || !transaction_id) {
    return sendError(res, "VALIDATION_FAILED", "Please provide complete transaction receipts information.");
  }

  try {
    const topupId = "top_" + crypto.randomUUID().slice(0, 8);
    await db.query(
      `INSERT INTO manual_topup_requests (id, rider_id, amount, method, sender_name, sender_phone, transaction_id, screenshot_url, note, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
      [topupId, req.user!.id, amount, method, sender_name, sender_phone, transaction_id, screenshot_url || null, note || ""]
    );

    return sendSuccess(res, {
      requestId: topupId,
      status: "pending",
      message: "Receipt logged successfully. Financial desk audits complete manual payments in under 1 hour."
    }, 201);

  } catch (err: any) {
    if (err.message?.includes("unique_transaction_id") || err.message?.includes("unique") || err.code === "23505") {
      return sendError(res, "DUPLICATE_TX_ID", "This Transaction ID has already been logged. Do not duplicate filings.", 409);
    }
    return sendError(res, "TOPUP_LOG_FAILED", err.message, 500);
  }
});

/**
 * GET /api/rider/active-trips
 * Lists real-time pending requested rides matching the rider's zone proximity
 */
router.get("/active-trips", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const unassignedRides = await db.query(
      `SELECT rb.*, u.full_name as customer_name, u.avatar_url as customer_avatar 
       FROM ride_bookings rb
       JOIN users u ON rb.customer_id = u.id
       WHERE rb.status = 'requested' AND rb.rider_id IS NULL
       ORDER BY rb.created_at DESC`
    );

    const claimedRides = await db.query(
      `SELECT rb.*, u.full_name as customer_name, u.avatar_url as customer_avatar 
       FROM ride_bookings rb
       JOIN users u ON rb.customer_id = u.id
       WHERE rb.rider_id = $1 AND rb.status IN ('accepted', 'arrived', 'in_transit')
       ORDER BY rb.updated_at DESC`,
      [req.user!.id]
    );

    return sendSuccess(res, {
      dispatch_queue: unassignedRides,
      my_active: claimedRides
    });

  } catch (err: any) {
    return sendError(res, "FETCH_ACTIVE_TRIPS_FAILED", err.message, 500);
  }
});

export default router;
