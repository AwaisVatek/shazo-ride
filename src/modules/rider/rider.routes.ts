import { Router, Request, Response } from "express";
import { requireAuth, requireRider, requireWalletEligibleRider, requireVerifiedRider, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { db } from "../../db/index";
import { domainNotifier } from "../../services/notification.service";
import { computeEtaMinutes } from "../../services/eta.service";
import { io } from "../../server";

const router = Router();

// Secure entire route segment to riders only
router.use(requireAuth, requireRider);

// rider_wallets/rider_wallet_ledger/rider_vehicles/rider_documents all key
// rider_id off rider_profiles.id, NOT users.id — every handler that touches
// those tables must resolve this first instead of using the authenticated
// user's own id directly (found via pg_get_constraintdef against production;
// this was silently breaking wallet balance, vehicle, and document lookups
// for every rider).
async function resolveRiderProfileId(userId: string): Promise<string | null> {
  const rows = await db.query("SELECT id FROM rider_profiles WHERE user_id = $1", [userId]);
  return rows.length > 0 ? rows[0].id : null;
}

/**
 * PATCH /api/rider/toggle-online
 * Toggle rider online/offline status manually
 */
router.patch("/toggle-online", requireVerifiedRider, requireWalletEligibleRider, async (req: AuthenticatedRequest, res: Response) => {
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
    const riderProfileId = await resolveRiderProfileId(authReq.user!.id);
    if (!riderProfileId) return sendError(res, "PROFILE_MISSING", "Rider profile not found.", 404);

    const wallets = await db.query("SELECT balance FROM rider_wallets WHERE rider_id = $1", [riderProfileId]);
    const balance = wallets.length > 0 ? Number(wallets[0].balance) : 0.00;

    const ledger = await db.query(
      `SELECT * FROM rider_wallet_ledger
       WHERE rider_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [riderProfileId]
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
 * GET /api/rider/wallet/payment-accounts
 * The active bank/mobile-wallet channels a rider can send a manual transfer
 * to. Previously only exposed via an admin-only route — riders had no way to
 * actually see which account to send money to before submitting a top-up
 * request with a transaction ID (same gap as the customer app).
 */
router.get("/wallet/payment-accounts", async (req: Request, res: Response) => {
  try {
    const accounts = await db.query(
      "SELECT id, account_type, bank_name, account_title, account_number, instructions FROM manual_payment_accounts WHERE is_active = true ORDER BY display_order ASC"
    );
    return sendSuccess(res, { accounts });
  } catch (err: any) {
    return sendError(res, "FETCH_PAYMENT_ACCOUNTS_FAILED", err.message);
  }
});

/**
 * POST /api/rider/wallet/topup
 * Submits a top-up request to the manual verification queue.
 *
 * Was inserting into `wallet_topups`, a table that doesn't exist in the
 * database at all — this endpoint 500'd on every single call. The real,
 * admin-integrated table (already read/approved correctly by
 * finance.routes.ts's PATCH /topups/:id, which credits rider_wallets on
 * approval) is `manual_topup_requests`, with columns
 * id/rider_id/amount/payment_method/transaction_id/screenshot_url/status —
 * a near-exact match for this endpoint's payload. The old separate
 * POST /manual-topup route also targeted this table but with column names
 * that don't exist there either (method/sender_name/sender_phone/note vs.
 * the real payment_method/notes) and nothing in the app called it — removed
 * as broken, unused duplicate code rather than fixed in place.
 */
router.post("/wallet/topup", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { amount, payment_method, transaction_id, screenshot_url } = req.body;

  if (!amount || amount <= 0 || !payment_method || !transaction_id) {
    return sendError(res, "VALIDATION_FAILED", "Please provide a valid amount, payment method, and transaction ID.");
  }

  try {
    const riderProfileId = await resolveRiderProfileId(authReq.user!.id);
    if (!riderProfileId) return sendError(res, "PROFILE_MISSING", "Rider profile not found.", 404);

    const existing = await db.query(
      "SELECT id FROM manual_topup_requests WHERE transaction_id = $1 OR (rider_id = $2 AND status = 'pending')",
      [transaction_id, riderProfileId]
    );

    if (existing.length > 0) {
      return sendError(res, "TOPUP_PENDING", "You already have a pending top-up or the transaction ID was already used.");
    }

    await db.query(
      `INSERT INTO manual_topup_requests (rider_id, amount, payment_method, transaction_id, screenshot_url)
       VALUES ($1, $2, $3, $4, $5)`,
      [riderProfileId, amount, payment_method, transaction_id, screenshot_url || null]
    );

    return sendSuccess(res, { message: "Top-up request submitted successfully. It will be verified by an admin shortly." });
  } catch (error: any) {
    return sendError(res, "TOPUP_FAILED", error.message, 500);
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
  const {
    full_name, email, profile_image_url,
    vehicle_type, vehicle_model, vehicle_number,
    city, cnic, license_expiry,
  } = req.body;

  try {
    // Was manual BEGIN/COMMIT/ROLLBACK via db.query() — each call checks out
    // its own connection from the pool, so nothing here was actually atomic
    // (same bug found and fixed in the customer app's PATCH /customer/me).
    // Also: city/cnic/license_expiry were collected by the registration
    // screens but never accepted here at all — rider_profiles had no columns
    // for city or license_expiry until migration 0017.
    await db.transaction(async (client) => {
      if (full_name !== undefined || email !== undefined || profile_image_url !== undefined) {
        await client.query(
          `UPDATE users SET
            full_name = COALESCE($1, full_name),
            email = COALESCE($2, email),
            avatar_url = COALESCE($3, avatar_url),
            updated_at = NOW()
           WHERE id = $4`,
          [full_name, email, profile_image_url, authReq.user!.id]
        );
      }

      if (vehicle_type !== undefined || vehicle_model !== undefined || vehicle_number !== undefined
        || city !== undefined || cnic !== undefined || license_expiry !== undefined) {
        await client.query(
          `UPDATE rider_profiles SET
            vehicle_type = COALESCE($1, vehicle_type),
            vehicle_model = COALESCE($2, vehicle_model),
            vehicle_number = COALESCE($3, vehicle_number),
            city = COALESCE($4, city),
            cnic = COALESCE($5, cnic),
            license_expiry = COALESCE($6, license_expiry),
            updated_at = NOW()
           WHERE user_id = $7`,
          [vehicle_type, vehicle_model, vehicle_number, city, cnic, license_expiry || null, authReq.user!.id]
        );
      }
    });

    return sendSuccess(res, { message: "Profile updated successfully." });
  } catch (error: any) {
    return sendError(res, "UPDATE_ERROR", error.message);
  }
});

/**
 * POST /api/rider/go-online
 */
router.post("/go-online", requireVerifiedRider, requireWalletEligibleRider, async (req: Request, res: Response) => {
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
  await db.query("UPDATE rider_profiles SET current_lat = $1, current_lng = $2, last_location_at = NOW(), updated_at = NOW() WHERE user_id = $3", [latitude, longitude, authReq.user!.id]);

  // Push this position live to any ride this driver currently has active,
  // so the customer's map can animate the driver's marker in real time.
  const activeRides = await db.query(
    "SELECT id, status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng FROM ride_bookings WHERE rider_id = $1 AND status IN ('accepted', 'arrived', 'in_transit')",
    [authReq.user!.id]
  );

  for (const ride of activeRides) {
    const target = ride.status === "in_transit"
      ? { lat: ride.dropoff_lat, lng: ride.dropoff_lng }
      : { lat: ride.pickup_lat, lng: ride.pickup_lng };

    const etaMinutes = target.lat != null && target.lng != null
      ? await computeEtaMinutes(latitude, longitude, target.lat, target.lng)
      : null;

    io.to(ride.id).emit("driver_location", {
      rideId: ride.id,
      latitude,
      longitude,
      etaMinutes
    });
  }

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
          OR (rb.rider_id = $1 AND rb.status IN ('accepted', 'arrived', 'in_transit'))
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
      "UPDATE ride_bookings SET status = 'accepted', rider_id = $1, updated_at = NOW() WHERE id = $2",
      [authReq.user!.id, rideId]
    );
    await db.query("COMMIT");

    io.to(rideId).emit("ride_update", { rideId, status: "accepted" });

    const customer = await db.query("SELECT phone FROM users WHERE id = $1", [ride[0].customer_id]);
    const rider = await db.query("SELECT u.full_name, rv.registration_number AS vehicle_number, rv.make_model AS vehicle_model FROM users u LEFT JOIN rider_vehicles rv ON u.id = rv.rider_id WHERE u.id = $1", [authReq.user!.id]);

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
    if (ride[0].status !== "accepted") {
      return sendError(res, "INVALID_TRANSITION", `Cannot mark as arrived from status '${ride[0].status}'.`);
    }

    await db.query("UPDATE ride_bookings SET status = 'arrived', updated_at = NOW() WHERE id = $1", [req.params.id]);
    io.to(req.params.id).emit("ride_update", { rideId: req.params.id, status: "arrived" });

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
    if (ride[0].status !== "arrived") {
      return sendError(res, "INVALID_TRANSITION", `Cannot start ride from status '${ride[0].status}'.`);
    }

    await db.query("UPDATE ride_bookings SET status = 'in_transit', updated_at = NOW() WHERE id = $1", [req.params.id]);
    io.to(req.params.id).emit("ride_update", { rideId: req.params.id, status: "in_transit" });

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
    if (ride[0].status !== "in_transit") {
      return sendError(res, "INVALID_TRANSITION", `Cannot complete ride from status '${ride[0].status}'.`);
    }

    await db.query("UPDATE ride_bookings SET status = 'completed', updated_at = NOW() WHERE id = $1", [req.params.id]);
    io.to(req.params.id).emit("ride_update", { rideId: req.params.id, status: "completed" });

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

/**
 * GET /api/rider/vehicle
 */
router.get("/vehicle", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const riderProfileId = await resolveRiderProfileId(authReq.user!.id);
    if (!riderProfileId) return sendError(res, "PROFILE_MISSING", "Rider profile not found.", 404);
    const vehicles = await db.query("SELECT * FROM rider_vehicles WHERE rider_id = $1", [riderProfileId]);
    return sendSuccess(res, { vehicle: vehicles[0] || null });
  } catch (error: any) {
    return sendError(res, "FETCH_FAILED", error.message);
  }
});

/**
 * POST /api/rider/vehicle
 */
router.post("/vehicle", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { make_model, color, license_plate, year, vehicle_category, registration_number, ownership_status, registration_document_url, vehicle_images } = req.body;
  try {
    const riderProfileId = await resolveRiderProfileId(authReq.user!.id);
    if (!riderProfileId) return sendError(res, "PROFILE_MISSING", "Rider profile not found.", 404);

    const existing = await db.query("SELECT id FROM rider_vehicles WHERE rider_id = $1", [riderProfileId]);
    if (existing.length > 0) {
      // Registration is a two-step flow: VehicleDetailsScreen sends make/
      // model/color/etc, then VehicleDocumentsScreen sends only
      // registration_document_url/vehicle_images. Without COALESCE on every
      // column, that second call would overwrite all the vehicle details
      // from the first call with NULL, since they're undefined in that
      // request body.
      await db.query(
        `UPDATE rider_vehicles SET
          make_model = COALESCE($1, make_model),
          color = COALESCE($2, color),
          license_plate = COALESCE($3, license_plate),
          year = COALESCE($4, year),
          vehicle_category = COALESCE($5, vehicle_category),
          type = COALESCE($5, type),
          registration_number = COALESCE($6, registration_number),
          ownership_status = COALESCE($7, ownership_status),
          registration_document_url = COALESCE($8, registration_document_url),
          vehicle_images = COALESCE($9, vehicle_images),
          verification_status = 'pending'
         WHERE rider_id = $10`,
        [make_model, color, license_plate, year, vehicle_category, registration_number, ownership_status, registration_document_url, vehicle_images, riderProfileId]
      );
    } else {
      // type is NOT NULL with no default, but neither this route nor any
      // frontend screen ever populated it — every first-time vehicle save
      // failed outright. vehicle_category (bike/car/rickshaw/ambulance,
      // matching rider_profiles.vehicle_type's vocabulary) is the closest
      // real signal available, so it backs both columns.
      const vid = "veh_" + Math.random().toString(36).substring(2, 10);
      await db.query(
        `INSERT INTO rider_vehicles (id, rider_id, make_model, color, license_plate, year, vehicle_category, type, registration_number, ownership_status, registration_document_url, vehicle_images)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11)`,
        [vid, riderProfileId, make_model, color, license_plate, year, vehicle_category, registration_number, ownership_status, registration_document_url, vehicle_images]
      );
    }
    return sendSuccess(res, { message: "Vehicle details updated successfully." });
  } catch (error: any) {
    return sendError(res, "UPDATE_FAILED", error.message);
  }
});

/**
 * GET /api/rider/documents
 */
router.get("/documents", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const riderProfileId = await resolveRiderProfileId(authReq.user!.id);
    if (!riderProfileId) return sendError(res, "PROFILE_MISSING", "Rider profile not found.", 404);
    const docs = await db.query("SELECT * FROM rider_documents WHERE rider_id = $1", [riderProfileId]);
    return sendSuccess(res, { documents: docs });
  } catch (error: any) {
    return sendError(res, "FETCH_FAILED", error.message);
  }
});

/**
 * POST /api/rider/documents
 */
router.post("/documents", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { document_type, file_url } = req.body;
  try {
    const riderProfileId = await resolveRiderProfileId(authReq.user!.id);
    if (!riderProfileId) return sendError(res, "PROFILE_MISSING", "Rider profile not found.", 404);

    const existing = await db.query("SELECT id FROM rider_documents WHERE rider_id = $1 AND document_type = $2", [riderProfileId, document_type]);
    if (existing.length > 0) {
      await db.query(
        "UPDATE rider_documents SET file_url = $1, status = 'pending_review' WHERE id = $2",
        [file_url, existing[0].id]
      );
    } else {
      const did = "doc_" + Math.random().toString(36).substring(2, 10);
      await db.query(
        "INSERT INTO rider_documents (id, rider_id, document_type, file_url) VALUES ($1, $2, $3, $4)",
        [did, riderProfileId, document_type, file_url]
      );
    }
    return sendSuccess(res, { message: "Document uploaded successfully." });
  } catch (error: any) {
    return sendError(res, "UPLOAD_FAILED", error.message);
  }
});

export default router;
