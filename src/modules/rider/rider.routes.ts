import { Router, Request, Response } from "express";
import crypto from "crypto";
import { requireAuth, requireRider, requireWalletEligibleRider, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { db } from "../../db/index";
import { domainNotifier } from "../../services/notification.service";

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
router.get("/wallet", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const wallets = await db.query("SELECT balance FROM rider_wallets WHERE rider_id = $1", [authReq.user!.id]);
    const balance = wallets.length > 0 ? Number(wallets[0].balance) : 0.00;

    const ledger = await db.query(
      `SELECT * FROM rider_wallet_ledger 
       WHERE rider_id = $1 
       ORDER BY created_at DESC LIMIT 50`,
      [authReq.user!.id]
    );

    return sendSuccess(res, {
      balance,
      history: ledger
    });

  } catch (err: any) {
    return sendError(res, "WALLET_FETCH_FAILED", err.message, 500);
  }
});

/**
 * POST /api/rider/wallet/topup
 * Submits a top-up request to the manual verification queue
 */
router.post("/wallet/topup", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { amount, payment_method, transaction_id } = req.body;

  if (!amount || amount <= 0 || !payment_method || !transaction_id) {
    return sendError(res, "VALIDATION_FAILED", "Please provide a valid amount, payment method, and transaction ID.");
  }

  try {
    // Check for duplicate pending transaction
    const existing = await db.query(
      "SELECT id FROM wallet_topups WHERE transaction_id = $1 OR (rider_id = $2 AND status = 'pending')",
      [transaction_id, authReq.user!.id]
    );

    if (existing.length > 0) {
      return sendError(res, "TOPUP_PENDING", "You already have a pending top-up or the transaction ID was already used.");
    }

    const topupId = "wtp_" + crypto.randomUUID().slice(0, 8);
    await db.query(
      `INSERT INTO wallet_topups (id, rider_id, amount, payment_method, transaction_id, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [topupId, authReq.user!.id, amount, payment_method, transaction_id]
    );

    return sendSuccess(res, { message: "Top-up request submitted successfully. It will be verified by an admin shortly." });
  } catch (error: any) {
    return sendError(res, "TOPUP_FAILED", error.message, 500);
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

/**
 * GET /api/rider/me
 * Retrieves full rider profile
 */
router.get("/me", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const userRows = await db.query(
      `SELECT u.id, u.full_name, u.phone, u.email, u.avatar_url as profile_image_url, 
              rp.vehicle_type, rp.vehicle_model, rp.vehicle_number, rp.is_verified as docs_verified, rp.is_online
       FROM users u
       LEFT JOIN rider_profiles rp ON u.id = rp.user_id
       WHERE u.id = $1`,
      [authReq.user!.id] // Fixed `req.user!.id` references for JWT setup
    );

    if (userRows.length === 0) {
      return sendError(res, "NOT_FOUND", "Rider profile not found.", 404);
    }

    return sendSuccess(res, { profile: userRows[0] });
  } catch (error: any) {
    return sendError(res, "FETCH_ERROR", error.message);
  }
});

/**
 * PATCH /api/rider/me
 */
router.patch("/me", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { full_name, email, profile_image_url, vehicle_type, vehicle_model, vehicle_number } = req.body;

  try {
    await db.query("BEGIN");

    if (full_name !== undefined || email !== undefined || profile_image_url !== undefined) {
      await db.query(
        `UPDATE users SET 
          full_name = COALESCE($1, full_name), 
          email = COALESCE($2, email),
          avatar_url = COALESCE($3, avatar_url),
          updated_at = NOW()
         WHERE id = $4`,
        [full_name, email, profile_image_url, authReq.user!.id]
      );
    }

    if (vehicle_type !== undefined || vehicle_model !== undefined || vehicle_number !== undefined) {
      await db.query(
        `UPDATE rider_profiles SET 
          vehicle_type = COALESCE($1, vehicle_type),
          vehicle_model = COALESCE($2, vehicle_model),
          vehicle_number = COALESCE($3, vehicle_number),
          updated_at = NOW()
         WHERE user_id = $4`,
        [vehicle_type, vehicle_model, vehicle_number, authReq.user!.id]
      );
    }

    await db.query("COMMIT");
    return sendSuccess(res, { message: "Profile updated successfully." });
  } catch (error: any) {
    await db.query("ROLLBACK");
    return sendError(res, "UPDATE_ERROR", error.message);
  }
});

/**
 * POST /api/rider/documents
 */
router.post("/documents", async (req: Request, res: Response) => {
  return sendSuccess(res, { message: "Documents received and pending admin approval." });
});

/**
 * POST /api/rider/go-online
 */
router.post("/go-online", requireWalletEligibleRider, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  await db.query("UPDATE rider_profiles SET is_online = true, updated_at = NOW() WHERE user_id = $1", [authReq.user!.id]);
  return sendSuccess(res, { is_online: true, message: "You are now online." });
});

/**
 * POST /api/rider/go-offline
 */
router.post("/go-offline", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  await db.query("UPDATE rider_profiles SET is_online = false, updated_at = NOW() WHERE user_id = $1", [authReq.user!.id]);
  return sendSuccess(res, { is_online: false, message: "You are now offline." });
});

/**
 * PATCH /api/rider/location
 */
router.patch("/location", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { latitude, longitude } = req.body;
  if (!latitude || !longitude) return sendError(res, "VALIDATION_FAILED", "latitude and longitude required");

  // In production, update PostGIS or Redis here. For MVP, we'll log it.
  await db.query("UPDATE rider_profiles SET last_lat = $1, last_lng = $2, updated_at = NOW() WHERE user_id = $3", [latitude, longitude, authReq.user!.id]);
  return sendSuccess(res, { message: "Location updated." });
});

/**
 * GET /api/rider/status
 */
router.get("/status", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const rows = await db.query("SELECT is_online, is_verified FROM rider_profiles WHERE user_id = $1", [authReq.user!.id]);
  if (rows.length === 0) return sendError(res, "NOT_FOUND", "Profile missing");
  return sendSuccess(res, rows[0]);
});

// --- RIDER JOBS LIFECYCLE ---

/**
 * GET /api/rider/jobs
 * Returns jobs matching this rider's service profile in 'requested' state, or currently assigned to them.
 */
router.get("/jobs", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const jobs = await db.query(
      `SELECT rb.*, u.full_name as customer_name, u.phone as customer_phone
       FROM ride_bookings rb
       LEFT JOIN users u ON rb.customer_id = u.id
       WHERE (rb.status = 'requested' AND rb.rider_id IS NULL) 
          OR (rb.rider_id = $1 AND rb.status IN ('assigned', 'arrived', 'in_transit'))
       ORDER BY rb.created_at DESC`,
      [authReq.user!.id]
    );
    return sendSuccess(res, { jobs });
  } catch (error: any) {
    return sendError(res, "FETCH_JOBS_FAILED", error.message);
  }
});

/**
 * POST /api/rider/jobs/:id/accept
 */
router.post("/jobs/:id/accept", requireWalletEligibleRider, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const rideId = req.params.id;

  try {
    await db.query("BEGIN");
    const ride = await db.query("SELECT * FROM ride_bookings WHERE id = $1 FOR UPDATE", [rideId]);
    if (ride.length === 0 || ride[0].status !== "requested") {
      await db.query("ROLLBACK");
      return sendError(res, "INVALID_JOB", "Job is no longer available.");
    }

    await db.query(
      "UPDATE ride_bookings SET status = 'assigned', rider_id = $1, updated_at = NOW() WHERE id = $2",
      [authReq.user!.id, rideId]
    );
    await db.query("COMMIT");

    const customer = await db.query("SELECT phone FROM users WHERE id = $1", [ride[0].customer_id]);
    const rider = await db.query("SELECT u.full_name, rp.vehicle_number, rp.vehicle_model FROM users u LEFT JOIN rider_profiles rp ON u.id = rp.user_id WHERE u.id = $1", [authReq.user!.id]);

    if (customer.length > 0 && rider.length > 0) {
      await domainNotifier.dispatch(customer[0].phone, "rider_assigned", {
        riderName: rider[0].full_name,
        vehicleInfo: `${rider[0].vehicle_model} (${rider[0].vehicle_number})`
      });
    }

    return sendSuccess(res, { message: "Job accepted successfully." });
  } catch (error: any) {
    await db.query("ROLLBACK");
    return sendError(res, "ACCEPT_FAILED", error.message);
  }
});

/**
 * POST /api/rider/jobs/:id/reject
 */
router.post("/jobs/:id/reject", async (req: Request, res: Response) => {
  // A rider rejecting a broadcasted job simply ignores it.
  return sendSuccess(res, { message: "Job rejected/ignored." });
});

/**
 * POST /api/rider/jobs/:id/arrived
 */
router.post("/jobs/:id/arrived", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const ride = await db.query("SELECT * FROM ride_bookings WHERE id = $1 AND rider_id = $2", [req.params.id, authReq.user!.id]);
    if (ride.length === 0) return sendError(res, "INVALID_JOB", "Job not found or not yours.");
    
    await db.query("UPDATE ride_bookings SET status = 'arrived', updated_at = NOW() WHERE id = $1", [req.params.id]);
    
    const customer = await db.query("SELECT phone FROM users WHERE id = $1", [ride[0].customer_id]);
    if (customer.length > 0) await domainNotifier.dispatch(customer[0].phone, "rider_arrived", {});

    return sendSuccess(res, { message: "Status updated to arrived." });
  } catch (error: any) {
    return sendError(res, "UPDATE_FAILED", error.message);
  }
});

/**
 * POST /api/rider/jobs/:id/start
 */
router.post("/jobs/:id/start", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const ride = await db.query("SELECT * FROM ride_bookings WHERE id = $1 AND rider_id = $2", [req.params.id, authReq.user!.id]);
    if (ride.length === 0) return sendError(res, "INVALID_JOB", "Job not found.");
    
    await db.query("UPDATE ride_bookings SET status = 'in_transit', updated_at = NOW() WHERE id = $1", [req.params.id]);
    
    const customer = await db.query("SELECT phone FROM users WHERE id = $1", [ride[0].customer_id]);
    if (customer.length > 0) await domainNotifier.dispatch(customer[0].phone, "ride_started", {});

    return sendSuccess(res, { message: "Ride started successfully." });
  } catch (error: any) {
    return sendError(res, "UPDATE_FAILED", error.message);
  }
});

/**
 * POST /api/rider/jobs/:id/complete
 */
router.post("/jobs/:id/complete", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const ride = await db.query("SELECT * FROM ride_bookings WHERE id = $1 AND rider_id = $2", [req.params.id, authReq.user!.id]);
    if (ride.length === 0) return sendError(res, "INVALID_JOB", "Job not found.");
    
    await db.query("UPDATE ride_bookings SET status = 'completed', updated_at = NOW() WHERE id = $1", [req.params.id]);
    
    // Ledger deduction is handled by the financial processor or legacy routes,
    // but we notify the customer immediately
    const customer = await db.query("SELECT phone FROM users WHERE id = $1", [ride[0].customer_id]);
    if (customer.length > 0) {
      await domainNotifier.dispatch(customer[0].phone, "ride_completed", {
        fare: ride[0].fare,
        currency: 'PKR'
      });
    }

    return sendSuccess(res, { message: "Ride completed successfully." });
  } catch (error: any) {
    return sendError(res, "UPDATE_FAILED", error.message);
  }
});

export default router;
