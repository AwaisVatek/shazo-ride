import { Router, Request, Response } from "express";
import crypto from "crypto";
import { requireAuth, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { db } from "../../db/index";
import { computeRoute } from "../../services/eta.service";
import { io } from "../../server";

const router = Router();
router.use(requireAuth);

/**
 * GET /api/customer/me
 * Retrieves full customer profile including profile specific fields
 */
router.get("/me", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  if (authReq.user.role !== "customer") {
    return sendError(res, "UNAUTHORIZED", "Access restricted to customer accounts.", 403);
  }

  try {
    const userRows = await db.query(
      `SELECT u.id, u.full_name, u.phone, u.email, u.avatar_url as profile_image_url, 
              cp.default_city, cp.emergency_contact_name, cp.emergency_contact_phone
       FROM users u
       LEFT JOIN customer_profiles cp ON u.id = cp.user_id
       WHERE u.id = $1`,
      [authReq.user!.id]
    );

    if (userRows.length === 0) {
      return sendError(res, "NOT_FOUND", "Customer profile not found.", 404);
    }

    return sendSuccess(res, { profile: userRows[0] });
  } catch (error: any) {
    return sendError(res, "FETCH_ERROR", error.message);
  }
});

/**
 * PATCH /api/customer/me
 * Updates customer profile
 */
router.patch("/me", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  if (authReq.user.role !== "customer") {
    return sendError(res, "UNAUTHORIZED", "Access restricted to customer accounts.", 403);
  }

  const { full_name, email, profile_image_url, default_city, emergency_contact_name, emergency_contact_phone } = req.body;

  try {
    // Previously used manual BEGIN/COMMIT/ROLLBACK via db.query(), but each
    // db.query() call checks out its own connection from the pool — BEGIN,
    // the two UPDATEs, and COMMIT could each run on a different connection,
    // so nothing was actually atomic. db.transaction() runs the whole
    // callback on one held connection, which is what real atomicity needs.
    // Also: customer_profiles has no updated_at column (unlike users) — that
    // was making every profile edit that touched default_city/emergency
    // contact fields fail outright with a "column does not exist" error.
    await db.transaction(async (client) => {
      if (full_name !== undefined || email !== undefined || profile_image_url !== undefined) {
        await client.query(
          `UPDATE users SET
            full_name = COALESCE($1, full_name),
            email = COALESCE($2, email),
            avatar_url = COALESCE($3, avatar_url),
            profile_completed = true,
            updated_at = NOW()
           WHERE id = $4`,
          [full_name, email, profile_image_url, authReq.user!.id]
        );
      }

      if (default_city !== undefined || emergency_contact_name !== undefined || emergency_contact_phone !== undefined) {
        await client.query(
          `UPDATE customer_profiles SET
            default_city = COALESCE($1, default_city),
            emergency_contact_name = COALESCE($2, emergency_contact_name),
            emergency_contact_phone = COALESCE($3, emergency_contact_phone)
           WHERE user_id = $4`,
          [default_city, emergency_contact_name, emergency_contact_phone, authReq.user!.id]
        );
      }
    });

    const updatedProfile = await db.query(
      `SELECT u.id, u.full_name, u.phone, u.email, u.avatar_url as profile_image_url,
              cp.default_city, cp.emergency_contact_name, cp.emergency_contact_phone
       FROM users u
       LEFT JOIN customer_profiles cp ON u.id = cp.user_id
       WHERE u.id = $1`,
      [authReq.user!.id]
    );

    return sendSuccess(res, { profile: updatedProfile[0] });
  } catch (error: any) {
    return sendError(res, "UPDATE_ERROR", error.message);
  }
});

// --- SAVED PLACES ---
router.get("/saved-places", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const places = await db.query(
      `SELECT id, label, address, latitude, longitude, place_type, created_at, updated_at
       FROM customer_saved_places
       WHERE customer_id = $1
       ORDER BY CASE place_type WHEN 'home' THEN 0 WHEN 'work' THEN 1 ELSE 2 END, updated_at DESC`,
      [authReq.user!.id]
    );
    return sendSuccess(res, { places });
  } catch (error: any) {
    return sendError(res, "FETCH_SAVED_PLACES_FAILED", error.message, 500);
  }
});

router.post("/saved-places", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { label, address, latitude, longitude, place_type } = req.body;
  const normalizedLabel = typeof label === "string" ? label.trim() : "";
  const normalizedAddress = typeof address === "string" ? address.trim() : "";
  const lat = Number(latitude);
  const lng = Number(longitude);
  const allowedTypes = ["home", "work", "other"];
  const normalizedType = allowedTypes.includes(place_type) ? place_type : "other";

  if (!normalizedLabel || !normalizedAddress || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return sendError(res, "VALIDATION_FAILED", "Label, address, latitude and longitude are required.", 400);
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return sendError(res, "VALIDATION_FAILED", "Saved-place coordinates are outside the valid range.", 400);
  }

  try {
    const id = "place_" + crypto.randomUUID().replaceAll("-", "");
    const places = await db.query(
      `INSERT INTO customer_saved_places (id, customer_id, label, address, latitude, longitude, place_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (customer_id, label) DO UPDATE SET
         address = EXCLUDED.address,
         latitude = EXCLUDED.latitude,
         longitude = EXCLUDED.longitude,
         place_type = EXCLUDED.place_type,
         updated_at = NOW()
       RETURNING id, label, address, latitude, longitude, place_type, created_at, updated_at`,
      [id, authReq.user!.id, normalizedLabel, normalizedAddress, lat, lng, normalizedType]
    );
    return sendSuccess(res, { place: places[0] }, 201);
  } catch (error: any) {
    return sendError(res, "SAVE_PLACE_FAILED", error.message, 500);
  }
});

router.delete("/saved-places/:id", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const removed = await db.query(
      "DELETE FROM customer_saved_places WHERE id = $1 AND customer_id = $2 RETURNING id",
      [req.params.id, authReq.user!.id]
    );
    if (removed.length === 0) return sendError(res, "NOT_FOUND", "Saved place not found.", 404);
    return sendSuccess(res, { id: removed[0].id, message: "Saved place removed." });
  } catch (error: any) {
    return sendError(res, "DELETE_SAVED_PLACE_FAILED", error.message, 500);
  }
});

// --- RIDES ---
/**
 * GET /api/customer/rides
 */
router.get("/rides", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const rides = await db.query(
      "SELECT * FROM ride_bookings WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50",
      [authReq.user!.id]
    );
    return sendSuccess(res, { rides });
  } catch (err: any) {
    return sendError(res, "FETCH_FAILED", err.message);
  }
});

// --- FOOD MVP ---
/**
 * GET /api/customer/food/restaurants
 */
router.get("/food/restaurants", async (req: Request, res: Response) => {
  try {
    const restaurants = await db.query("SELECT * FROM restaurant_profiles WHERE is_active = true ORDER BY name ASC");
    return sendSuccess(res, { restaurants });
  } catch (err: any) {
    return sendError(res, "FETCH_FAILED", err.message);
  }
});

/**
 * GET /api/customer/food/restaurants/:id/menu
 */
router.get("/food/restaurants/:id/menu", async (req: Request, res: Response) => {
  try {
    const categories = await db.query("SELECT * FROM menu_categories WHERE restaurant_id = $1 ORDER BY display_order ASC", [req.params.id]);
    const items = await db.query("SELECT * FROM menu_items WHERE restaurant_id = $1 AND is_available = true", [req.params.id]);
    return sendSuccess(res, { categories, items });
  } catch (err: any) {
    return sendError(res, "FETCH_FAILED", err.message);
  }
});

/**
 * POST /api/customer/food/order
 */
router.post("/food/order", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { restaurant_id, delivery_address, delivery_lat, delivery_lng, total_amount, items } = req.body;
  if (!restaurant_id || !delivery_address || !items || items.length === 0) {
    return sendError(res, "VALIDATION_FAILED", "Invalid order payload.");
  }
  try {
    const orderId = "fod_" + crypto.randomUUID().slice(0, 8);
    await db.query(
      `INSERT INTO food_orders (id, customer_id, restaurant_id, delivery_address, delivery_lat, delivery_lng, total_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ordered')`,
      [orderId, authReq.user!.id, restaurant_id, delivery_address, delivery_lat, delivery_lng, total_amount]
    );
    return sendSuccess(res, { message: "Order placed successfully.", order_id: orderId });
  } catch (err: any) {
    return sendError(res, "ORDER_FAILED", err.message);
  }
});

// --- AMBULANCE ---
/**
 * POST /api/customer/ambulance/estimate
 * Precomputes the fare an ambulance request would actually charge, so the
 * request screen can show a real number (or "Free Service") before the
 * customer commits — previously there was no way to see this before
 * submitting. Must compute the exact same number /ambulance/request below
 * actually charges, not a different formula that could disagree with it.
 */
router.post("/ambulance/estimate", async (req: Request, res: Response) => {
  const { pickup_lat, pickup_lng, hospital_lat, hospital_lng } = req.body;

  if (pickup_lat === undefined || pickup_lng === undefined) {
    return sendError(res, "VALIDATION_FAILED", "Pickup location is required for an ambulance estimate.");
  }

  try {
    const rates = await db.query("SELECT * FROM service_settings WHERE service_type = 'ambulance'");
    const rate = rates[0];
    if (!rate) {
      return sendError(res, "CONFIG_MISSING", "Ambulance service is not currently configured.");
    }
    const isFree = !!rate.settings?.free_service_enabled;

    if (isFree) {
      return sendSuccess(res, { is_free: true, total_fare: 0 });
    }

    let distanceFare = 0;
    let totalFare = Number(rate.base_fare ?? 300);

    if (hospital_lat !== undefined && hospital_lng !== undefined) {
      const route = await computeRoute(pickup_lat, pickup_lng, hospital_lat, hospital_lng);
      if (route) {
        distanceFare = Number((route.distanceKm * Number(rate.per_km_rate ?? 0)).toFixed(2));
        totalFare = Math.max(
          Number(rate.base_fare ?? 0) + distanceFare,
          Number(rate.minimum_fare ?? 0)
        );
      }
    }

    return sendSuccess(res, {
      is_free: false,
      base_fare: Number(rate.base_fare ?? 0),
      distance_fare: distanceFare,
      total_fare: totalFare,
      minimum_fare: Number(rate.minimum_fare ?? 0),
    });
  } catch (err: any) {
    return sendError(res, "AMBULANCE_ESTIMATE_FAILED", err.message, 500);
  }
});

/**
 * POST /api/customer/ambulance/request
 */
router.post("/ambulance/request", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const {
    pickup_address, pickup_lat, pickup_lng,
    hospital_address, hospital_lat, hospital_lng,
    emergency_type, patient_name, patient_phone, notes
  } = req.body;

  if (!pickup_address || pickup_lat === undefined || pickup_lng === undefined) {
    return sendError(res, "VALIDATION_FAILED", "Pickup location is required for ambulance.");
  }

  try {
    const rates = await db.query("SELECT * FROM service_settings WHERE service_type = 'ambulance'");
    const rate = rates[0];
    const isFree = !!rate?.settings?.free_service_enabled;

    let distanceFare = 0;
    let totalFare = Number(rate?.base_fare ?? 300);

    if (!isFree && hospital_lat !== undefined && hospital_lng !== undefined) {
      const route = await computeRoute(pickup_lat, pickup_lng, hospital_lat, hospital_lng);
      if (route) {
        distanceFare = Number((route.distanceKm * Number(rate?.per_km_rate ?? 0)).toFixed(2));
        totalFare = Math.max(
          Number(rate?.base_fare ?? 0) + distanceFare,
          Number(rate?.minimum_fare ?? 0)
        );
      }
    } else if (isFree) {
      totalFare = 0;
    }

    // Fall back to the requesting customer's own profile for patient contact info
    // (an emergency form shouldn't force someone to retype their own name/phone).
    const requester = await db.query("SELECT full_name, phone FROM users WHERE id = $1", [authReq.user!.id]);
    const resolvedPatientName = patient_name || requester[0]?.full_name || null;
    const resolvedPatientPhone = patient_phone || requester[0]?.phone || null;

    const bookingId = "amb_" + crypto.randomUUID().slice(0, 8);
    await db.query(
      `INSERT INTO ambulance_bookings (
         id, customer_id, patient_name, patient_phone, emergency_type,
         pickup_address, pickup_lat, pickup_lng, hospital_address, hospital_lat, hospital_lng,
         base_dispatch_fee, distance_fare, total_fare, is_free, notes, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'requested')`,
      [
        bookingId, authReq.user!.id, resolvedPatientName, resolvedPatientPhone, emergency_type || "General Emergency",
        pickup_address, pickup_lat, pickup_lng, hospital_address || null, hospital_lat ?? null, hospital_lng ?? null,
        Number(rate?.base_fare ?? 300), distanceFare, totalFare, isFree, notes || null
      ]
    );

    const created = await db.query("SELECT * FROM ambulance_bookings WHERE id = $1", [bookingId]);
    return sendSuccess(res, { message: "Ambulance requested successfully. Help is on the way.", booking: created[0] }, 201);
  } catch (err: any) {
    return sendError(res, "AMBULANCE_FAILED", err.message);
  }
});

/**
 * GET /api/customer/ambulance/requests
 * Lists the requesting customer's own ambulance bookings, most recent first.
 */
router.get("/ambulance/requests", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const requests = await db.query(
      "SELECT * FROM ambulance_bookings WHERE customer_id = $1 ORDER BY created_at DESC",
      [authReq.user!.id]
    );
    return sendSuccess(res, { requests });
  } catch (err: any) {
    return sendError(res, "FETCH_AMBULANCE_REQUESTS_FAILED", err.message);
  }
});

/**
 * GET /api/customer/ambulance/requests/:id
 */
router.get("/ambulance/requests/:id", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const rows = await db.query("SELECT * FROM ambulance_bookings WHERE id = $1", [req.params.id]);
    if (rows.length === 0) return sendError(res, "NOT_FOUND", "No ambulance request matches this ID.", 404);
    if (rows[0].customer_id !== authReq.user!.id) {
      return sendError(res, "FORBIDDEN", "You are not authorized to view this ambulance request.", 403);
    }
    return sendSuccess(res, { request: rows[0] });
  } catch (err: any) {
    return sendError(res, "FETCH_AMBULANCE_REQUEST_FAILED", err.message);
  }
});

// --- WALLET / LEDGER ---
// There is no payment gateway wired into this system anywhere. Top-ups are a
// manual bank-transfer + admin-approval flow, mirroring how rider wallet
// top-ups already work — no instant/fake "success" on a client-supplied amount.

/**
 * GET /api/customer/wallet
 */
router.get("/wallet", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const wallets = await db.query("SELECT balance FROM customer_wallets WHERE customer_id = $1", [authReq.user!.id]);
    const balance = wallets.length > 0 ? Number(wallets[0].balance) : 0;

    const ledgerRows = await db.query(
      "SELECT id, amount, transaction_type, note, created_at FROM customer_wallet_ledger WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50",
      [authReq.user!.id]
    );
    const transactions = ledgerRows.map((r: any) => ({
      id: r.id,
      type: Number(r.amount) >= 0 ? "credit" : "debit",
      amount: Math.abs(Number(r.amount)),
      description: r.note || (r.transaction_type === "manual_topup" ? "Wallet Top-up" : r.transaction_type),
      created_at: r.created_at,
    }));

    return sendSuccess(res, { balance, transactions });
  } catch (err: any) {
    return sendError(res, "FETCH_WALLET_FAILED", err.message);
  }
});

/**
 * GET /api/customer/wallet/payment-accounts
 * The active bank/mobile-wallet channels a customer can send a manual
 * transfer to. Previously only exposed via an admin-only route — customers
 * had no way to actually see which account to send money to before
 * submitting a top-up request with a transaction ID.
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
 * POST /api/customer/wallet/topup
 * Files a manual top-up request — credited only after admin approval (see
 * PATCH /api/finance/customer-topups/:id).
 */
router.post("/wallet/topup", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { amount, payment_method, transaction_id, screenshot_url } = req.body;
  if (!amount || amount <= 0) return sendError(res, "INVALID_AMOUNT", "Amount must be greater than zero.");

  try {
    const requestId = "ctopup_" + crypto.randomUUID().slice(0, 8);
    await db.query(
      `INSERT INTO customer_manual_topup_requests (id, customer_id, amount, payment_method, transaction_id, screenshot_url, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [requestId, authReq.user!.id, amount, payment_method || "bank_transfer", transaction_id || null, screenshot_url || null]
    );
    const created = await db.query("SELECT * FROM customer_manual_topup_requests WHERE id = $1", [requestId]);
    return sendSuccess(res, {
      message: "Your top-up request has been submitted and is pending admin approval.",
      request: created[0]
    }, 201);
  } catch (err: any) {
    return sendError(res, "TOPUP_FAILED", err.message);
  }
});

/**
 * GET /api/customer/wallet/topups
 * The customer's own top-up request history, so the app can show pending/rejected status.
 */
router.get("/wallet/topups", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const requests = await db.query(
      "SELECT * FROM customer_manual_topup_requests WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50",
      [authReq.user!.id]
    );
    return sendSuccess(res, { requests });
  } catch (err: any) {
    return sendError(res, "FETCH_TOPUPS_FAILED", err.message);
  }
});

export default router;
