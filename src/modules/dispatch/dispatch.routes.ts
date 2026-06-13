import { Router, Request, Response } from "express";
import { requireAuth, requireOperationsManager, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { db } from "../../db/index";

const router = Router();

router.use(requireAuth, requireOperationsManager);

/**
 * GET /api/dispatch/unassigned
 * Compiles a real-time tracking list of unassigned mobility bookings awaiting drivers
 */
router.get("/unassigned", async (req: Request, res: Response) => {
  try {
    const rides = await db.query(
      `SELECT rb.*, u.full_name as customer_name, u.phone as customer_phone
       FROM ride_bookings rb
       JOIN users u ON rb.customer_id = u.id
       WHERE rb.status = 'requested' AND rb.rider_id IS NULL
       ORDER BY rb.created_at ASC`
    );

    const orders = await db.query(
      `SELECT fo.*, u.full_name as customer_name, r.name as restaurant_name
       FROM food_orders fo
       JOIN users u ON fo.customer_id = u.id
       JOIN restaurant_profiles r ON fo.restaurant_id = r.id
       WHERE fo.status = 'ordered' AND fo.rider_id IS NULL
       ORDER BY fo.created_at ASC`
    );

    return sendSuccess(res, {
      rides,
      food_orders: orders
    });

  } catch (err: any) {
    return sendError(res, "FETCH_UNASSIGNED_DISPATCH_FAILED", err.message, 500);
  }
});

/**
 * POST /api/dispatch/assign-ride
 * Forcefully attaches an unassigned ride booking to a specific online rider
 */
router.post("/assign-ride", async (req: AuthenticatedRequest, res: Response) => {
  const { ride_id, rider_id } = req.body;
  if (!ride_id || !rider_id) return sendError(res, "VALIDATION_FAILED", "Please provide ride_id and rider_id.");

  try {
    // 1. Verify target status holds requested state
    const matches = await db.query("SELECT status FROM ride_bookings WHERE id = $1", [ride_id]);
    if (matches.length === 0) return sendError(res, "RIDE_NOT_FOUND", "No ride matches this key.", 404);

    if (matches[0].status !== "requested") {
      return sendError(res, "INVALID_STATE", `Cannot assign ride that holds state: '${matches[0].status}'.`, 400);
    }

    // 2. Verify rider status bounds online verified parameters
    const riders = await db.query("SELECT is_online, verification_status FROM rider_profiles WHERE user_id = $1", [rider_id]);
    if (riders.length === 0) return sendError(res, "RIDER_NOT_FOUND", "Rider profile does not exist.", 404);

    if (!riders[0].is_online || riders[0].verification_status !== "verified") {
      return sendError(res, "RIDER_INACTIVE", "Target pilot is currently either offline or unreviewed.", 400);
    }

    // 3. Force update assignment
    await db.query(
      "UPDATE ride_bookings SET rider_id = $1, status = 'accepted', updated_at = NOW() WHERE id = $2",
      [rider_id, ride_id]
    );

    return sendSuccess(res, {
      ride_id,
      assigned_rider: rider_id,
      status: "accepted",
      message: "The requested ride was manually dispatched to the specified rider successfully."
    });

  } catch (err: any) {
    return sendError(res, "MANUAL_DISPATCH_RIDE_FAILED", err.message, 500);
  }
});

export default router;
