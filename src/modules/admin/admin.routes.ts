import { Router, Request, Response } from "express";
import crypto from "crypto";
import { requireAuth, requireAdmin, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { db } from "../../db/index";

const router = Router();

// Lock down route segment to admins only
router.use(requireAuth, requireAdmin);

/**
 * GET /api/admin/dashboard
 * Compiles aggregated analytics and operational metrics for system monitoring
 */
router.get("/dashboard", async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Collect stats totals
    const customerCount = await db.query("SELECT COUNT(*) as count FROM users WHERE role = 'customer'");
    const riderCount = await db.query("SELECT COUNT(*) as count FROM users WHERE role = 'rider'");
    const activeRiders = await db.query("SELECT COUNT(*) as count FROM rider_profiles WHERE is_online = true");
    const activeRides = await db.query("SELECT COUNT(*) as count FROM ride_bookings WHERE status IN ('accepted', 'arrived', 'in_transit')");
    const pendingRides = await db.query("SELECT COUNT(*) as count FROM ride_bookings WHERE status = 'requested'");
    const activeAmbulances = await db.query("SELECT COUNT(*) as count FROM ambulance_bookings WHERE status IN ('requested', 'dispatched', 'arrived')");
    const totalFoodOrders = await db.query("SELECT COUNT(*) as count FROM food_orders");

    // Financial calculations
    const walletsSum = await db.query("SELECT SUM(balance) as total FROM rider_wallets");
    const pendingTopups = await db.query("SELECT COUNT(*) as count FROM manual_topup_requests WHERE status = 'pending'");

    return sendSuccess(res, {
      metrics: {
        customers_total: Number(customerCount[0]?.count || 0),
        riders_total: Number(riderCount[0]?.count || 0),
        riders_online: Number(activeRiders[0]?.count || 0),
        active_rides_in_progress: Number(activeRides[0]?.count || 0),
        pending_rides_in_queue: Number(pendingRides[0]?.count || 0),
        emergency_ambulances_active: Number(activeAmbulances[0]?.count || 0),
        total_food_dispatches_handled: Number(totalFoodOrders[0]?.count || 0)
      },
      finance: {
        rider_deposits_pool: Number(walletsSum[0]?.total || 0).toFixed(2),
        pending_topups_count: Number(pendingTopups[0]?.count || 0)
      }
    });

  } catch (err: any) {
    return sendError(res, "ADMIN_DASHBOARD_COMPILATION_FAILED", err.message, 500);
  }
});

/**
 * PATCH /api/admin/settings
 * Updates parameters like fare structures, minimum prices, and base commissions
 */
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

    // Logging audit action trace
    const logId = "log_" + crypto.randomUUID().slice(0, 8);
    await db.query(
      `INSERT INTO audit_logs (id, user_id, role, action, target_table, notes)
       VALUES ($1, $2, 'admin', 'update_service_rates', 'service_settings', $3)`,
      [logId, req.user!.id, `Rates for service '${service_type}' modified by admin.`]
    );

    const updated = await db.query("SELECT * FROM service_settings WHERE service_type = $1", [service_type]);
    return sendSuccess(res, { configuration: updated[0] });

  } catch (err: any) {
    return sendError(res, "UPDATE_SETTINGS_FAILED", err.message, 500);
  }
});

/**
 * GET /api/admin/audit
 * Pulls security logs trails
 */
router.get("/audit", async (req: Request, res: Response) => {
  try {
    const logs = await db.query("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100");
    return sendSuccess(res, { logs });
  } catch (err: any) {
    return sendError(res, "FETCH_AUDIT_LOGS_FAILED", err.message, 500);
  }
});

export default router;
