import { Router, Request, Response } from "express";
import crypto from "crypto";
import { requireAuth, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { db } from "../../db/index";

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
    // Start atomic transaction
    await db.query("BEGIN");

    // 1. Update basic users table info if provided
    if (full_name !== undefined || email !== undefined || profile_image_url !== undefined) {
      await db.query(
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

    // 2. Update specific customer_profile fields
    if (default_city !== undefined || emergency_contact_name !== undefined || emergency_contact_phone !== undefined) {
      await db.query(
        `UPDATE customer_profiles SET 
          default_city = COALESCE($1, default_city),
          emergency_contact_name = COALESCE($2, emergency_contact_name),
          emergency_contact_phone = COALESCE($3, emergency_contact_phone),
          updated_at = NOW()
         WHERE user_id = $4`,
        [default_city, emergency_contact_name, emergency_contact_phone, authReq.user!.id]
      );
    }

    await db.query("COMMIT");

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
    await db.query("ROLLBACK");
    return sendError(res, "UPDATE_ERROR", error.message);
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

// --- AMBULANCE MVP ---
/**
 * POST /api/customer/ambulance/request
 */
router.post("/ambulance/request", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { pickup_address, pickup_lat, pickup_lng, emergency_type, patient_condition } = req.body;
  if (!pickup_address || !pickup_lat || !pickup_lng) {
    return sendError(res, "VALIDATION_FAILED", "Pickup location is required for ambulance.");
  }
  try {
    const bookingId = "amb_" + crypto.randomUUID().slice(0, 8);
    await db.query(
      `INSERT INTO ambulance_bookings (id, customer_id, pickup_address, pickup_lat, pickup_lng, emergency_type, patient_condition, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'requested')`,
      [bookingId, authReq.user!.id, pickup_address, pickup_lat, pickup_lng, emergency_type, patient_condition]
    );
    return sendSuccess(res, { message: "Ambulance requested successfully. Help is on the way.", booking_id: bookingId });
  } catch (err: any) {
    return sendError(res, "AMBULANCE_FAILED", err.message);
  }
});

// --- WALLET / LEDGER ---
/**
 * GET /api/customer/wallet
 */
router.get("/wallet", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const transactions = await db.query(
      "SELECT * FROM ledger_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
      [authReq.user!.id]
    );
    
    // Calculate current balance
    const balanceResult = await db.query(
      "SELECT SUM(amount) as balance FROM ledger_transactions WHERE user_id = $1",
      [authReq.user!.id]
    );
    
    const balance = balanceResult[0]?.balance || 0;
    
    return sendSuccess(res, { balance, transactions });
  } catch (err: any) {
    return sendError(res, "FETCH_WALLET_FAILED", err.message);
  }
});

/**
 * POST /api/customer/wallet/topup
 */
router.post("/wallet/topup", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { amount, payment_method, reference_id } = req.body;
  if (!amount || amount <= 0) return sendError(res, "INVALID_AMOUNT", "Amount must be greater than zero.");
  
  try {
    const txId = "tx_" + crypto.randomUUID().slice(0, 8);
    await db.query(
      `INSERT INTO ledger_transactions (id, user_id, transaction_type, amount, currency, status, reference_id, metadata)
       VALUES ($1, $2, 'topup', $3, 'PKR', 'completed', $4, $5)`,
      [txId, authReq.user!.id, amount, reference_id || null, { payment_method }]
    );
    return sendSuccess(res, { message: "Wallet topped up successfully.", transaction_id: txId, amount_added: amount });
  } catch (err: any) {
    return sendError(res, "TOPUP_FAILED", err.message);
  }
});

export default router;
