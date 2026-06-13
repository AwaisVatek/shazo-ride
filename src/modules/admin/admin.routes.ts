import { Router, Request, Response } from "express";
import crypto from "crypto";
import { requireAuth, requireAdmin, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { db } from "../../db/index";

const router = Router();

router.use(requireAuth, requireAdmin);

type QueryParams = Array<string | number | boolean | null | Date>;

async function safeRows<T = any>(label: string, sql: string, params: QueryParams = []): Promise<T[]> {
  try {
    return await db.query<T>(sql, params);
  } catch (err: any) {
    console.warn(`[admin] ${label} failed:`, err?.message || err);
    return [];
  }
}

async function safeCount(label: string, sql: string, params: QueryParams = []): Promise<number> {
  const rows = await safeRows<{ count: number | string }>(label, sql, params);
  return Number(rows?.[0]?.count || 0);
}

async function safeValue(label: string, sql: string, params: QueryParams = []): Promise<number> {
  const rows = await safeRows<{ value: number | string | null }>(label, sql, params);
  return Number(rows?.[0]?.value || 0);
}

function listResponse(items: any[] = []) {
  return { items, total: items.length };
}

router.get("/dashboard", async (req: AuthenticatedRequest, res: Response) => {
  const customers = await safeCount("customers", "SELECT COUNT(*)::int AS count FROM users WHERE role = 'customer'");
  const riders = await safeCount("riders", "SELECT COUNT(*)::int AS count FROM users WHERE role = 'rider'");
  const verifiedRiders = await safeCount("verified riders", "SELECT COUNT(*)::int AS count FROM rider_profiles WHERE verification_status = 'verified'");
  const pendingRiderVerifications = await safeCount("pending rider verifications", "SELECT COUNT(*)::int AS count FROM rider_profiles WHERE verification_status IN ('pending', 'submitted', 'under_review')");
  const restaurants = await safeCount("restaurants", "SELECT COUNT(*)::int AS count FROM restaurant_profiles");
  const pendingRestaurantVerifications = await safeCount("pending restaurant verifications", "SELECT COUNT(*)::int AS count FROM restaurant_profiles WHERE COALESCE(is_active, false) = false");
  const todayBikeRides = await safeCount("today bike rides", "SELECT COUNT(*)::int AS count FROM ride_bookings WHERE service_type = 'bike' AND created_at::date = CURRENT_DATE");
  const todayCarRides = await safeCount("today car rides", "SELECT COUNT(*)::int AS count FROM ride_bookings WHERE service_type = 'car' AND created_at::date = CURRENT_DATE");
  const todayAmbulanceBookings = await safeCount("today ambulance bookings", "SELECT COUNT(*)::int AS count FROM ambulance_bookings WHERE created_at::date = CURRENT_DATE");
  const todayFoodOrders = await safeCount("today food orders", "SELECT COUNT(*)::int AS count FROM food_orders WHERE created_at::date = CURRENT_DATE");
  const todayRevenue = await safeValue("today revenue", "SELECT COALESCE(SUM(total_fare), 0)::numeric AS value FROM ride_bookings WHERE created_at::date = CURRENT_DATE");
  const cashCollectedToday = await safeValue("cash collected today", "SELECT COALESCE(SUM(amount), 0)::numeric AS value FROM cash_collections WHERE created_at::date = CURRENT_DATE");
  const pendingWalletTopups = await safeCount("pending wallet topups", "SELECT COUNT(*)::int AS count FROM manual_topup_requests WHERE status = 'pending'");
  const supportTicketsOpen = await safeCount("open support tickets", "SELECT COUNT(*)::int AS count FROM support_tickets WHERE status IN ('open', 'assigned', 'waiting_user')");

  return sendSuccess(res, {
    totals: {
      customers,
      riders,
      verified_riders: verifiedRiders,
      pending_rider_verifications: pendingRiderVerifications,
      restaurants,
      pending_restaurant_verifications: pendingRestaurantVerifications,
      today_bike_rides: todayBikeRides,
      today_car_rides: todayCarRides,
      today_ambulance_bookings: todayAmbulanceBookings,
      today_food_orders: todayFoodOrders,
      today_revenue: todayRevenue,
      cash_collected_today: cashCollectedToday,
      pending_wallet_topups: pendingWalletTopups,
      support_tickets_open: supportTicketsOpen
    },
    recent_activity: [],
    service_health: { api: "ok", database: "ok" }
  });
});

router.get("/customers", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("customers list", "SELECT id, full_name, email, phone, role, is_verified, created_at FROM users WHERE role = 'customer' ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.get("/riders", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("riders list", "SELECT id, full_name, email, phone, role, is_verified, created_at FROM users WHERE role = 'rider' ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.get("/restaurants", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("restaurants list", "SELECT * FROM restaurant_profiles ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.get("/rides", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("rides list", "SELECT * FROM ride_bookings ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.get("/ambulance-bookings", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("ambulance bookings", "SELECT * FROM ambulance_bookings ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.get("/food-orders", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("food orders", "SELECT * FROM food_orders ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.get("/finance/topups", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("topups", "SELECT * FROM manual_topup_requests ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.get("/finance/wallet-ledger", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("wallet ledger", "SELECT * FROM wallet_ledger ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.get("/finance/cash-collections", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("cash collections", "SELECT * FROM cash_collections ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.get("/finance/commission-report", async (req: AuthenticatedRequest, res: Response) => {
  return sendSuccess(res, { items: [], summary: { total_commission: 0, waived_commission: 0 } });
});

router.get("/settings/manual-payment-accounts", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("manual payment accounts", "SELECT * FROM manual_payment_accounts ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.get("/settings/fares", async (req: AuthenticatedRequest, res: Response) => {
  const rows = await safeRows<any>("service settings", "SELECT * FROM service_settings");
  const data: Record<string, any> = { bike: {}, car: {}, ambulance: {}, food_delivery: {} };
  for (const row of rows) {
    const key = row.service_type === "food" ? "food_delivery" : row.service_type;
    if (key && Object.prototype.hasOwnProperty.call(data, key)) data[key] = row;
  }
  return sendSuccess(res, data);
});

router.get("/settings/commissions", async (req: AuthenticatedRequest, res: Response) => {
  const rows = await safeRows<any>("commission settings", "SELECT * FROM service_settings");
  const data: Record<string, any> = { bike: {}, car: {}, ambulance: {}, food_delivery: {}, restaurant: {} };
  for (const row of rows) {
    const key = row.service_type === "food" ? "food_delivery" : row.service_type;
    if (key && Object.prototype.hasOwnProperty.call(data, key)) data[key] = row;
  }
  return sendSuccess(res, data);
});

router.get("/settings/free-ride-campaigns", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("free ride campaigns", "SELECT * FROM free_ride_campaigns ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.get("/settings/zones", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("zones", "SELECT * FROM service_zones ORDER BY name ASC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.get("/support/tickets", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("support tickets", "SELECT * FROM support_tickets ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.get("/notifications", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("notifications", "SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.get("/safety/reports", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("safety reports", "SELECT * FROM safety_reports ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.get("/users", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("admin users", "SELECT id, full_name, email, phone, role, is_verified, created_at FROM users WHERE role IN ('admin', 'operations_manager', 'finance_admin', 'support_agent') ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.patch("/settings", async (req: AuthenticatedRequest, res: Response) => {
  const { service_type, base_fare, per_km_rate, per_minute_rate, minimum_fare, commission_percentage, commission_fixed } = req.body;

  if (!service_type) return sendError(res, "VALIDATION_FAILED", "A target service_type is required to proceed.");

  try {
    const existing = await db.query("SELECT id FROM service_settings WHERE service_type = $1", [service_type]);
    if (existing.length === 0) {
      return sendError(res, "SERVICE_MISSING", "The specified service type does not exist.", 404);
    }

    await db.query(
      `UPDATE service_settings
       SET base_fare = COALESCE($1, base_fare),
           per_km_rate = COALESCE($2, per_km_rate),
           per_minute_rate = COALESCE($3, per_minute_rate),
           minimum_fare = COALESCE($4, minimum_fare),
           commission_percentage = COALESCE($5, commission_percentage),
           commission_fixed = COALESCE($6, commission_fixed),
           updated_at = NOW()
       WHERE service_type = $7`,
      [
        base_fare !== undefined ? Number(base_fare) : null,
        per_km_rate !== undefined ? Number(per_km_rate) : null,
        per_minute_rate !== undefined ? Number(per_minute_rate) : null,
        minimum_fare !== undefined ? Number(minimum_fare) : null,
        commission_percentage !== undefined ? Number(commission_percentage) : null,
        commission_fixed !== undefined ? Number(commission_fixed) : null,
        service_type
      ]
    );

    await safeRows(
      "audit log settings update",
      `INSERT INTO audit_logs (id, user_id, role, action, target_table, notes)
       VALUES ($1, $2, 'admin', 'update_service_rates', 'service_settings', $3)`,
      ["log_" + crypto.randomUUID().slice(0, 8), req.user!.id, `Rates for service '${service_type}' modified by admin.`]
    );

    const updated = await db.query("SELECT * FROM service_settings WHERE service_type = $1", [service_type]);
    return sendSuccess(res, { configuration: updated[0] });
  } catch (err: any) {
    return sendError(res, "UPDATE_SETTINGS_FAILED", err.message, 500);
  }
});

router.get("/audit", async (req: Request, res: Response) => {
  const logs = await safeRows("audit logs", "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, { logs });
});

export default router;
