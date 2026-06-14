import { Router, Request, Response } from "express";
import { requireAuth, requireOperationsManager, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { db } from "../../db/index";

const router = Router();

router.use(requireAuth, requireOperationsManager);

type QueryParams = Array<string | number | boolean | null | Date>;

async function safeRows<T = any>(label: string, sql: string, params: QueryParams = []): Promise<T[]> {
  try {
    return await db.query<T>(sql, params);
  } catch (err: any) {
    console.warn(`[dispatch] ${label} failed:`, err?.message || err);
    return [];
  }
}

async function getUnassigned() {
  const rides = await safeRows("unassigned rides", `
    SELECT rb.*, u.full_name AS customer_name, u.phone AS customer_phone, 'ride' AS request_type
    FROM ride_bookings rb
    LEFT JOIN users u ON rb.customer_id = u.id
    WHERE rb.status = 'requested' AND rb.rider_id IS NULL
    ORDER BY rb.created_at ASC
    LIMIT 100
  `);

  const foodOrders = await safeRows("unassigned food", `
    SELECT fo.*, u.full_name AS customer_name, r.name AS restaurant_name, 'food_order' AS request_type
    FROM food_orders fo
    LEFT JOIN users u ON fo.customer_id = u.id
    LEFT JOIN restaurant_profiles r ON fo.restaurant_id = r.id
    WHERE fo.status = 'ordered' AND fo.rider_id IS NULL
    ORDER BY fo.created_at ASC
    LIMIT 100
  `);

  const ambulanceBookings = await safeRows("active ambulance", `
    SELECT ab.*, 'ambulance' AS request_type
    FROM ambulance_bookings ab
    WHERE ab.status IN ('requested', 'dispatched', 'arrived')
    ORDER BY ab.created_at ASC
    LIMIT 100
  `);

  return { rides, food_orders: foodOrders, ambulance_bookings: ambulanceBookings, items: [...rides, ...foodOrders, ...ambulanceBookings] };
}

router.get(["/active", "/unassigned"], async (req: Request, res: Response) => {
  return sendSuccess(res, await getUnassigned());
});

router.post("/assign", async (req: AuthenticatedRequest, res: Response) => {
  const requestId = req.body?.requestId || req.body?.ride_id || req.body?.order_id;
  const riderId = req.body?.riderId || req.body?.rider_id;
  if (!requestId || !riderId) return sendError(res, "VALIDATION_FAILED", "Please provide requestId and riderId.");

  const rideUpdate = await safeRows("assign ride", "UPDATE ride_bookings SET rider_id = $1, status = 'accepted', updated_at = NOW() WHERE id = $2 AND status IN ('requested', 'accepted') RETURNING id, status", [riderId, requestId]);
  if (rideUpdate.length > 0) return sendSuccess(res, { request_id: requestId, assigned_rider: riderId, status: "accepted" });

  const foodUpdate = await safeRows("assign food", "UPDATE food_orders SET rider_id = $1, status = 'accepted', updated_at = NOW() WHERE id = $2 AND status IN ('ordered', 'accepted') RETURNING id, status", [riderId, requestId]);
  if (foodUpdate.length > 0) return sendSuccess(res, { request_id: requestId, assigned_rider: riderId, status: "accepted" });

  return sendError(res, "REQUEST_NOT_FOUND", "No dispatchable ride or food order matches this request.", 404);
});

router.post("/assign-ride", async (req: AuthenticatedRequest, res: Response) => {
  req.body.requestId = req.body.ride_id;
  req.body.riderId = req.body.rider_id;
  const requestId = req.body.requestId;
  const riderId = req.body.riderId;
  if (!requestId || !riderId) return sendError(res, "VALIDATION_FAILED", "Please provide ride_id and rider_id.");
  const result = await safeRows("assign ride explicit", "UPDATE ride_bookings SET rider_id = $1, status = 'accepted', updated_at = NOW() WHERE id = $2 AND status IN ('requested', 'accepted') RETURNING id, status", [riderId, requestId]);
  if (result.length === 0) return sendError(res, "RIDE_NOT_FOUND", "No ride matches this key.", 404);
  return sendSuccess(res, { ride_id: requestId, assigned_rider: riderId, status: "accepted" });
});

router.delete("/:id", async (req: AuthenticatedRequest, res: Response) => {
  const id = req.params.id;
  const ride = await safeRows("cancel ride", "UPDATE ride_bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING id", [id]);
  const food = ride.length ? [] : await safeRows("cancel food", "UPDATE food_orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING id", [id]);
  const ambulance = ride.length || food.length ? [] : await safeRows("cancel ambulance", "UPDATE ambulance_bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING id", [id]);
  return sendSuccess(res, { id, cancelled: ride.length + food.length + ambulance.length > 0 });
});

export default router;
