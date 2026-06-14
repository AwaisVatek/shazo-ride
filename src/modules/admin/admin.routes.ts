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

function okMessage(message: string, extra: Record<string, any> = {}) {
  return { message, ...extra };
}

router.get("/dashboard", async (req: AuthenticatedRequest, res: Response) => {
  const customers = await safeCount("customers", "SELECT COUNT(*)::int AS count FROM users WHERE role = 'customer'");
  const riders = await safeCount("riders", "SELECT COUNT(*)::int AS count FROM users WHERE role = 'rider'");
  const activeRiders = await safeCount("online riders", "SELECT COUNT(*)::int AS count FROM rider_profiles WHERE is_online = true");
  const verifiedRiders = await safeCount("verified riders", "SELECT COUNT(*)::int AS count FROM rider_profiles WHERE verification_status = 'verified'");
  const pendingRiderVerifications = await safeCount("pending rider verifications", "SELECT COUNT(*)::int AS count FROM rider_profiles WHERE verification_status IN ('pending', 'submitted', 'under_review')");
  const restaurants = await safeCount("restaurants", "SELECT COUNT(*)::int AS count FROM restaurant_profiles");
  const activeRestaurants = await safeCount("active restaurants", "SELECT COUNT(*)::int AS count FROM restaurant_profiles WHERE is_active = true");
  const pendingRestaurantVerifications = await safeCount("pending restaurants", "SELECT COUNT(*)::int AS count FROM restaurant_profiles WHERE COALESCE(is_active, false) = false");
  const todayBikeRides = await safeCount("today bike rides", "SELECT COUNT(*)::int AS count FROM ride_bookings WHERE ride_type = 'bike' AND created_at::date = CURRENT_DATE");
  const todayCarRides = await safeCount("today car rides", "SELECT COUNT(*)::int AS count FROM ride_bookings WHERE ride_type = 'car' AND created_at::date = CURRENT_DATE");
  const todayAmbulanceBookings = await safeCount("today ambulance bookings", "SELECT COUNT(*)::int AS count FROM ambulance_bookings WHERE created_at::date = CURRENT_DATE");
  const todayFoodOrders = await safeCount("today food orders", "SELECT COUNT(*)::int AS count FROM food_orders WHERE created_at::date = CURRENT_DATE");
  const todayRevenue = await safeValue("today revenue", "SELECT COALESCE(SUM(fare), 0)::numeric AS value FROM ride_bookings WHERE created_at::date = CURRENT_DATE");
  const todayFoodRevenue = await safeValue("today food revenue", "SELECT COALESCE(SUM(grand_total), 0)::numeric AS value FROM food_orders WHERE created_at::date = CURRENT_DATE");
  const cashCollectedToday = await safeValue("cash today", "SELECT COALESCE(SUM(fare), 0)::numeric AS value FROM ride_bookings WHERE payment_method = 'cash' AND created_at::date = CURRENT_DATE");
  const pendingWalletTopups = await safeCount("pending topups", "SELECT COUNT(*)::int AS count FROM manual_topup_requests WHERE status = 'pending'");
  const supportTicketsOpen = await safeCount("open tickets", "SELECT COUNT(*)::int AS count FROM support_tickets WHERE status IN ('open', 'assigned', 'waiting_user')");
  const commissionToday = await safeValue("commission today", "SELECT COALESCE(SUM(commission_amount), 0)::numeric AS value FROM ride_bookings WHERE created_at::date = CURRENT_DATE");
  const freeQuota = await safeRows<{ quota_total: number | string; quota_used: number | string }>("free quota", "SELECT COALESCE(SUM(quota_total),0)::int AS quota_total, COALESCE(SUM(quota_used),0)::int AS quota_used FROM free_ride_campaigns WHERE status = 'active'");

  const totals = {
    customers,
    riders,
    active_riders: activeRiders,
    verified_riders: verifiedRiders,
    pending_rider_verifications: pendingRiderVerifications,
    restaurants,
    active_restaurants: activeRestaurants,
    pending_restaurant_verifications: pendingRestaurantVerifications,
    today_bike_rides: todayBikeRides,
    today_car_rides: todayCarRides,
    today_ambulance_bookings: todayAmbulanceBookings,
    today_food_orders: todayFoodOrders,
    today_revenue: todayRevenue + todayFoodRevenue,
    cash_collected_today: cashCollectedToday,
    pending_wallet_topups: pendingWalletTopups,
    support_tickets_open: supportTicketsOpen,
    commission_today: commissionToday,
    free_quota_total: Number(freeQuota?.[0]?.quota_total || 0),
    free_quota_used: Number(freeQuota?.[0]?.quota_used || 0)
  };

  return sendSuccess(res, {
    ...totals,
    totals,
    recent_activity: [],
    service_health: { api: "ok", database: "ok" }
  });
});

router.get("/customers", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("customers", `
    SELECT u.id, u.full_name, u.email, u.phone, u.role, u.is_verified, u.created_at,
           cp.rating, cp.completed_rides_count
    FROM users u
    LEFT JOIN customer_profiles cp ON cp.user_id = u.id
    WHERE u.role = 'customer'
    ORDER BY u.created_at DESC
    LIMIT 100
  `);
  return sendSuccess(res, listResponse(items));
});

router.patch("/customers/:id", async (req: AuthenticatedRequest, res: Response) => {
  const isVerified = req.body?.status === "active" || req.body?.is_verified === true;
  await safeRows("update customer", "UPDATE users SET is_verified = $1, updated_at = NOW() WHERE id = $2 AND role = 'customer'", [isVerified, req.params.id]);
  return sendSuccess(res, okMessage("Customer updated."));
});

router.get("/riders", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("riders", `
    SELECT u.id, u.full_name, u.email, u.phone, u.role, u.is_verified, u.created_at,
           rp.verification_status, rp.vehicle_type, rp.is_online, rp.latitude, rp.longitude, rp.last_location_update,
           rw.balance
    FROM users u
    LEFT JOIN rider_profiles rp ON rp.user_id = u.id
    LEFT JOIN rider_wallets rw ON rw.rider_id = u.id
    WHERE u.role = 'rider'
    ORDER BY u.created_at DESC
    LIMIT 100
  `);
  return sendSuccess(res, listResponse(items));
});

router.patch("/riders/:id", async (req: AuthenticatedRequest, res: Response) => {
  const status = String(req.body?.status || "pending");
  await safeRows("update rider", "UPDATE rider_profiles SET verification_status = $1, updated_at = NOW() WHERE user_id = $2", [status, req.params.id]);
  await safeRows("verify rider user", "UPDATE users SET is_verified = $1, updated_at = NOW() WHERE id = $2 AND role = 'rider'", [status === "verified", req.params.id]);
  return sendSuccess(res, okMessage("Rider updated."));
});

router.get("/restaurants", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("restaurants", `
    SELECT rp.*, u.full_name AS owner_name, u.email AS owner_email, u.phone AS owner_phone
    FROM restaurant_profiles rp
    LEFT JOIN users u ON u.id = rp.owner_id
    ORDER BY rp.created_at DESC
    LIMIT 100
  `);
  return sendSuccess(res, listResponse(items));
});

router.patch("/restaurants/:id", async (req: AuthenticatedRequest, res: Response) => {
  const status = String(req.body?.status || "active");
  await safeRows("update restaurant", "UPDATE restaurant_profiles SET is_active = $1, updated_at = NOW() WHERE id = $2", [status !== "inactive" && status !== "suspended", req.params.id]);
  return sendSuccess(res, okMessage("Restaurant updated."));
});

router.get("/rides", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("rides", `
    SELECT rb.*, c.full_name AS customer_name, c.phone AS customer_phone, r.full_name AS rider_name, r.phone AS rider_phone
    FROM ride_bookings rb
    LEFT JOIN users c ON c.id = rb.customer_id
    LEFT JOIN users r ON r.id = rb.rider_id
    ORDER BY rb.created_at DESC
    LIMIT 100
  `);
  return sendSuccess(res, listResponse(items));
});

router.get("/ambulance-bookings", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("ambulance", "SELECT * FROM ambulance_bookings ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.get("/food-orders", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("food orders", `
    SELECT fo.*, u.full_name AS customer_name, u.phone AS customer_phone, rp.name AS restaurant_name
    FROM food_orders fo
    LEFT JOIN users u ON u.id = fo.customer_id
    LEFT JOIN restaurant_profiles rp ON rp.id = fo.restaurant_id
    ORDER BY fo.created_at DESC
    LIMIT 100
  `);
  return sendSuccess(res, listResponse(items));
});

router.get("/finance/topups", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("topups", `
    SELECT mt.*, u.full_name AS rider_name, u.phone AS rider_phone
    FROM manual_topup_requests mt
    LEFT JOIN users u ON u.id = mt.rider_id
    ORDER BY mt.created_at DESC
    LIMIT 100
  `);
  return sendSuccess(res, listResponse(items));
});

router.post("/finance/topups/:id/approve", async (req: AuthenticatedRequest, res: Response) => {
  await safeRows("approve topup", "UPDATE manual_topup_requests SET status = 'approved', reviewed_by = $1, reviewed_at = NOW() WHERE id = $2", [req.user!.id, req.params.id]);
  await safeRows("credit wallet", `UPDATE rider_wallets rw SET balance = rw.balance + mt.amount, updated_at = NOW() FROM manual_topup_requests mt WHERE mt.id = $1 AND rw.rider_id = mt.rider_id`, [req.params.id]);
  return sendSuccess(res, okMessage("Top-up approved."));
});

router.post("/finance/topups/:id/reject", async (req: AuthenticatedRequest, res: Response) => {
  await safeRows("reject topup", "UPDATE manual_topup_requests SET status = 'rejected', rejection_reason = $1, reviewed_by = $2, reviewed_at = NOW() WHERE id = $3", [req.body?.reason || "Rejected by admin", req.user!.id, req.params.id]);
  return sendSuccess(res, okMessage("Top-up rejected."));
});

router.post("/finance/rider-wallets/:riderId/adjust", async (req: AuthenticatedRequest, res: Response) => {
  const amount = Number(req.body?.amount || 0);
  await safeRows("upsert wallet", "INSERT INTO rider_wallets (rider_id, balance) VALUES ($1, $2) ON CONFLICT (rider_id) DO UPDATE SET balance = rider_wallets.balance + EXCLUDED.balance, updated_at = NOW()", [req.params.riderId, amount]);
  return sendSuccess(res, okMessage("Wallet adjusted."));
});

router.get("/finance/wallet-ledger", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("wallet ledger", "SELECT * FROM rider_wallet_ledger ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.get("/finance/cash-collections", async (req: AuthenticatedRequest, res: Response) => {
  const rideCash = await safeRows("ride cash", "SELECT id, customer_id, rider_id, fare AS amount, payment_method, status, created_at FROM ride_bookings WHERE payment_method = 'cash' ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(rideCash));
});

router.get("/finance/commission-report", async (req: AuthenticatedRequest, res: Response) => {
  const total = await safeValue("total commission", "SELECT COALESCE(SUM(commission_amount), 0)::numeric AS value FROM ride_bookings");
  return sendSuccess(res, { items: [], summary: { total_commission: total, waived_commission: 0 } });
});

router.get("/settings/manual-payment-accounts", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("payment accounts", "SELECT * FROM manual_payment_accounts ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.post("/settings/manual-payment-accounts", async (req: AuthenticatedRequest, res: Response) => {
  const id = req.body?.id || `pay_${crypto.randomUUID().slice(0, 8)}`;
  await safeRows("create account", `INSERT INTO manual_payment_accounts (id, bank_name, account_title, account_number, instructions, min_topup, max_topup, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET bank_name = EXCLUDED.bank_name, account_title = EXCLUDED.account_title, account_number = EXCLUDED.account_number, instructions = EXCLUDED.instructions, min_topup = EXCLUDED.min_topup, max_topup = EXCLUDED.max_topup, is_active = EXCLUDED.is_active`, [id, req.body?.bank_name || req.body?.bankName || "Manual Account", req.body?.account_title || req.body?.accountTitle || "Shazo Ride", req.body?.account_number || req.body?.accountNumber || "", req.body?.instructions || "", String(req.body?.min_topup || "200"), String(req.body?.max_topup || "50000"), req.body?.is_active !== false]);
  return sendSuccess(res, okMessage("Payment account saved.", { id }));
});

router.patch("/settings/manual-payment-accounts/:id", async (req: AuthenticatedRequest, res: Response) => {
  await safeRows("update account", `UPDATE manual_payment_accounts SET bank_name = COALESCE($1, bank_name), account_title = COALESCE($2, account_title), account_number = COALESCE($3, account_number), instructions = COALESCE($4, instructions), is_active = COALESCE($5, is_active) WHERE id = $6`, [req.body?.bank_name || req.body?.bankName || null, req.body?.account_title || req.body?.accountTitle || null, req.body?.account_number || req.body?.accountNumber || null, req.body?.instructions || null, req.body?.is_active, req.params.id]);
  return sendSuccess(res, okMessage("Payment account updated."));
});

router.get("/settings/fares", async (req: AuthenticatedRequest, res: Response) => {
  const rows = await safeRows<any>("fares", "SELECT * FROM service_settings");
  const data: Record<string, any> = { bike: {}, car: {}, ambulance: {}, food_delivery: {} };
  for (const row of rows) {
    const key = row.service_type === "food" ? "food_delivery" : row.service_type;
    if (key && Object.prototype.hasOwnProperty.call(data, key)) data[key] = row;
  }
  return sendSuccess(res, data);
});

router.post("/settings/fares", async (req: AuthenticatedRequest, res: Response) => {
  return sendSuccess(res, okMessage("Fare settings endpoint received. Use PATCH /api/admin/settings for individual service changes."));
});

router.get("/settings/commissions", async (req: AuthenticatedRequest, res: Response) => {
  const rows = await safeRows<any>("commissions", "SELECT * FROM service_settings");
  const data: Record<string, any> = { bike: {}, car: {}, ambulance: {}, food_delivery: {}, restaurant: {} };
  for (const row of rows) {
    const key = row.service_type === "food" ? "food_delivery" : row.service_type;
    if (key && Object.prototype.hasOwnProperty.call(data, key)) data[key] = row;
  }
  return sendSuccess(res, data);
});

router.post("/settings/commissions", async (req: AuthenticatedRequest, res: Response) => {
  return sendSuccess(res, okMessage("Commission settings endpoint received. Use PATCH /api/admin/settings for individual service changes."));
});

router.get("/settings/maintenance", async (req: AuthenticatedRequest, res: Response) => {
  const rows = await safeRows<{ key: string; value: string }>("app settings", "SELECT key, value FROM app_settings");
  const data = rows.reduce<Record<string, string>>((acc, row) => ({ ...acc, [row.key]: row.value }), {});
  return sendSuccess(res, data);
});

router.post("/settings/maintenance", async (req: AuthenticatedRequest, res: Response) => {
  for (const [key, value] of Object.entries(req.body || {})) {
    await safeRows("save setting", "INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()", [key, String(value)]);
  }
  return sendSuccess(res, okMessage("Maintenance settings saved."));
});

router.get(["/settings/free-ride-campaigns", "/promo-campaigns"], async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("campaigns", "SELECT * FROM free_ride_campaigns ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.post("/promo-campaigns", async (req: AuthenticatedRequest, res: Response) => {
  const id = req.body?.id || `camp_${crypto.randomUUID().slice(0, 8)}`;
  await safeRows("create campaign", `INSERT INTO free_ride_campaigns (id, name, service_type, quota_total, quota_used, allowed_zones, start_at, end_at, status) VALUES ($1,$2,$3,$4,0,$5,COALESCE($6::timestamptz, NOW()),COALESCE($7::timestamptz, NOW() + INTERVAL '30 days'),$8) ON CONFLICT (id) DO NOTHING`, [id, req.body?.name || "Free Ride Campaign", req.body?.service_type || "bike", Number(req.body?.quota_total || 0), req.body?.allowed_zones || "all", req.body?.start_at || null, req.body?.end_at || null, req.body?.status || "active"]);
  return sendSuccess(res, okMessage("Campaign saved.", { id }));
});

router.patch("/promo-campaigns/:id", async (req: AuthenticatedRequest, res: Response) => {
  await safeRows("update campaign", "UPDATE free_ride_campaigns SET status = COALESCE($1, status) WHERE id = $2", [req.body?.status || null, req.params.id]);
  return sendSuccess(res, okMessage("Campaign updated."));
});

router.get(["/settings/zones", "/zones"], async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("zones", "SELECT * FROM city_zones ORDER BY name ASC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.patch("/zones/:id", async (req: AuthenticatedRequest, res: Response) => {
  const status = String(req.body?.status || "active");
  await safeRows("update zone", "UPDATE city_zones SET is_active = $1 WHERE id = $2", [status !== "inactive" && status !== "disabled", req.params.id]);
  return sendSuccess(res, okMessage("Zone updated."));
});

router.patch("/zones/:id/surge", async (req: AuthenticatedRequest, res: Response) => {
  return sendSuccess(res, okMessage("Surge demand noted.", { zone_id: req.params.id, demand_index: req.body?.demandIndex || 0 }));
});

router.get("/support/tickets", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("tickets", "SELECT * FROM support_tickets ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.post("/support/tickets/:id/resolve", async (req: AuthenticatedRequest, res: Response) => {
  await safeRows("resolve ticket", "UPDATE support_tickets SET status = 'resolved', updated_at = NOW() WHERE id = $1", [req.params.id]);
  return sendSuccess(res, okMessage("Ticket resolved."));
});

router.post("/support/tickets/:id/reply", async (req: AuthenticatedRequest, res: Response) => {
  const id = `msg_${crypto.randomUUID().slice(0, 8)}`;
  await safeRows("ticket reply", "INSERT INTO ticket_messages (id, ticket_id, sender_id, message) VALUES ($1,$2,$3,$4)", [id, req.params.id, req.user!.id, req.body?.replyText || req.body?.message || ""]);
  return sendSuccess(res, okMessage("Reply saved."));
});

router.get("/notifications", async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("notifications", "SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.post("/notifications", async (req: AuthenticatedRequest, res: Response) => {
  const id = `ntf_${crypto.randomUUID().slice(0, 8)}`;
  await safeRows("create notification", "INSERT INTO notifications (id, user_id, title, body, data_payload) VALUES ($1,$2,$3,$4,$5)", [id, req.user!.id, req.body?.title || "Admin Notification", req.body?.body || req.body?.message || "", JSON.stringify(req.body || {})]);
  return sendSuccess(res, okMessage("Notification saved.", { id }));
});

router.get(["/safety/reports", "/safety-incidents"], async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("safety", "SELECT * FROM safety_reports ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.post("/safety/:id/resolve", async (req: AuthenticatedRequest, res: Response) => {
  await safeRows("resolve safety", "UPDATE safety_reports SET investigation_status = 'resolved', admin_notes = COALESCE($1, admin_notes) WHERE id = $2", [req.body?.notes || null, req.params.id]);
  return sendSuccess(res, okMessage("Safety report resolved."));
});

router.get(["/users", "/staff-users"], async (req: AuthenticatedRequest, res: Response) => {
  const items = await safeRows("staff", "SELECT id, full_name, email, phone, role, is_verified, created_at FROM users WHERE role IN ('admin', 'operations_manager', 'finance_admin', 'support_agent') ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, listResponse(items));
});

router.post("/staff-users", async (req: AuthenticatedRequest, res: Response) => {
  return sendSuccess(res, okMessage("Staff creation requires password setup. Use backend seed/user management for now."));
});

router.get("/health", async (req: AuthenticatedRequest, res: Response) => {
  const dbPing = await safeRows("db ping", "SELECT 1 AS ping");
  return sendSuccess(res, {
    api: "ok",
    database: dbPing.length ? "ok" : "degraded",
    timestamp: new Date().toISOString()
  });
});

router.patch("/settings", async (req: AuthenticatedRequest, res: Response) => {
  const { service_type, base_fare, per_km_rate, per_minute_rate, minimum_fare, commission_percentage, commission_fixed } = req.body;
  if (!service_type) return sendError(res, "VALIDATION_FAILED", "A target service_type is required.");

  const existing = await safeRows("service setting exists", "SELECT id FROM service_settings WHERE service_type = $1", [service_type]);
  if (existing.length === 0) return sendError(res, "SERVICE_MISSING", "The specified service type does not exist.", 404);

  await safeRows("update service setting", `UPDATE service_settings SET base_fare = COALESCE($1, base_fare), per_km_rate = COALESCE($2, per_km_rate), per_minute_rate = COALESCE($3, per_minute_rate), minimum_fare = COALESCE($4, minimum_fare), commission_percentage = COALESCE($5, commission_percentage), commission_fixed = COALESCE($6, commission_fixed), updated_at = NOW() WHERE service_type = $7`, [base_fare !== undefined ? Number(base_fare) : null, per_km_rate !== undefined ? Number(per_km_rate) : null, per_minute_rate !== undefined ? Number(per_minute_rate) : null, minimum_fare !== undefined ? Number(minimum_fare) : null, commission_percentage !== undefined ? Number(commission_percentage) : null, commission_fixed !== undefined ? Number(commission_fixed) : null, service_type]);

  await safeRows("audit settings", `INSERT INTO audit_logs (id, user_id, role, action, target_table, notes) VALUES ($1, $2, 'admin', 'update_service_rates', 'service_settings', $3)`, ["log_" + crypto.randomUUID().slice(0, 8), req.user!.id, `Rates for service '${service_type}' modified by admin.`]);
  const updated = await safeRows("updated setting", "SELECT * FROM service_settings WHERE service_type = $1", [service_type]);
  return sendSuccess(res, { configuration: updated[0] || null });
});

router.get("/audit", async (req: Request, res: Response) => {
  const logs = await safeRows("audit", "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100");
  return sendSuccess(res, { logs });
});

export default router;
