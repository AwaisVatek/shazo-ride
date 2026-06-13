import { Router, Response } from "express";
import { requireAuth, requireRestaurant, requireActiveRestaurant, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { config } from "../../config/index";
import { db } from "../../db/index";

const router = Router();

router.use(requireAuth, requireRestaurant);

/**
 * GET /api/restaurant/profile
 * Retrieves store configuration mapping of the manager account
 */
router.get("/profile", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stores = await db.query("SELECT * FROM restaurant_profiles WHERE owner_id = $1", [req.user!.id]);
    if (stores.length === 0) {
      return sendError(res, "STORE_NOT_FOUND", "No restaurant registration is linked to this account.", 404);
    }

    return sendSuccess(res, { profile: stores[0] });
  } catch (err: any) {
    return sendError(res, "FETCH_PROFILE_FAILED", err.message, 500);
  }
});

/**
 * PATCH /api/restaurant/status
 * Toggles the kitchen's active operating status
 */
router.patch("/status", async (req: AuthenticatedRequest, res: Response) => {
  const { is_active } = req.body;
  if (is_active === undefined) return sendError(res, "VALIDATION_FAILED", "Please provide the active boolean status.");

  try {
    await db.query(
      "UPDATE restaurant_profiles SET is_active = $1, updated_at = NOW() WHERE owner_id = $2",
      [!!is_active, req.user!.id]
    );

    return sendSuccess(res, {
      is_active: !!is_active,
      message: is_active ? "Your kitchen is now online and accepting food dispatch orders." : "Your kitchen is offline."
    });

  } catch (err: any) {
    return sendError(res, "TOGGLE_KITCHEN_FAILED", err.message, 500);
  }
});

/**
 * GET /api/restaurant/orders
 * Lists kitchen orders parsed by status tracking queues
 */
router.get("/orders", requireActiveRestaurant, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stores = await db.query("SELECT id FROM restaurant_profiles WHERE owner_id = $1", [req.user!.id]);
    const storeId = stores[0].id;

    // Incoming new orders
    const incoming = await db.query(
      `SELECT fo.*, u.full_name as customer_name FROM food_orders fo
       JOIN users u ON fo.customer_id = u.id
       WHERE fo.restaurant_id = $1 AND fo.status = 'ordered'
       ORDER BY fo.created_at DESC`,
      [storeId]
    );

    // active preparation list
    const moving = await db.query(
      `SELECT fo.*, u.full_name as customer_name FROM food_orders fo
       JOIN users u ON fo.customer_id = u.id
       WHERE fo.restaurant_id = $1 AND fo.status IN ('accepted', 'preparing', 'ready', 'out_for_delivery')
       ORDER BY fo.updated_at DESC`,
      [storeId]
    );

    return sendSuccess(res, {
      incoming,
      preparing: moving
    });

  } catch (err: any) {
    return sendError(res, "FETCH_KITCHEN_ORDERS_FAILED", err.message, 500);
  }
});

/**
 * PATCH /api/restaurant/orders/:id
 * Controls preparing, cooking, and dispatch state loops of food containers
 */
router.patch("/orders/:id", requireActiveRestaurant, async (req: AuthenticatedRequest, res: Response) => {
  const orderId = req.params.id;
  const { status } = req.body; // accepted, preparing, ready

  if (!["accepted", "preparing", "ready"].includes(status)) {
    return sendError(res, "VALIDATION_FAILED", "Invalid order status transition target.");
  }

  try {
    const stores = await db.query("SELECT id FROM restaurant_profiles WHERE owner_id = $1", [req.user!.id]);
    const storeId = stores[0].id;

    const matched = await db.query("SELECT id FROM food_orders WHERE id = $1 AND restaurant_id = $2", [orderId, storeId]);
    if (matched.length === 0) {
      return sendError(res, "ORDER_UNAUTHORIZED", "This order is not assigned to your restaurant node.", 403);
    }

    await db.query("UPDATE food_orders SET status = $1, updated_at = NOW() WHERE id = $2", [status, orderId]);

    return sendSuccess(res, {
      orderId,
      status,
      message: `Kitchen order state transitioned to '${status}' successfully.`
    });

  } catch (err: any) {
    return sendError(res, "UPDATE_ORDER_STAGE_FAILED", err.message, 500);
  }
});

/**
 * GET /api/restaurant/menu
 * Pulls current menu categories to adjust items inventory
 */
router.get("/menu", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stores = await db.query("SELECT id FROM restaurant_profiles WHERE owner_id = $1", [req.user!.id]);
    const storeId = stores[0].id;

    // Call food menu endpoints synchronously
    const response = await fetch(`${config.API_BASE_URL}/api/food/restaurants/${storeId}/menu`, {
      headers: { "Authorization": req.headers.authorization! }
    });
    const catalog: any = await response.json();
    return res.status(200).json(catalog);

  } catch (err: any) {
    return sendError(res, "FETCH_STORE_CATALOG_FAILED", err.message, 500);
  }
});

/**
 * PATCH /api/restaurant/menu/:id
 * Allows operators to toggle the in-stock availability of direct menu items
 */
router.patch("/menu/:id", async (req: AuthenticatedRequest, res: Response) => {
  const itemId = req.params.id;
  const { is_available } = req.body;

  if (is_available === undefined) return sendError(res, "VALIDATION_FAILED", "Please provide is_available value.");

  try {
    const stores = await db.query("SELECT id FROM restaurant_profiles WHERE owner_id = $1", [req.user!.id]);
    const storeId = stores[0].id;

    // Cross-verify item owner identity
    const itemCheck = await db.query(
      `SELECT mi.id FROM restaurant_menu_items mi
       JOIN restaurant_menu_categories mc ON mi.category_id = mc.id
       WHERE mi.id = $1 AND mc.restaurant_id = $2`,
      [itemId, storeId]
    );

    if (itemCheck.length === 0) {
      return sendError(res, "ITEM_UNAUTHORIZED", "Menu item is unlinked or unauthorized.", 403);
    }

    await db.query(
      "UPDATE restaurant_menu_items SET is_available = $1, updated_at = NOW() WHERE id = $2",
      [!!is_available, itemId]
    );

    return sendSuccess(res, {
      itemId,
      is_available: !!is_available,
      message: `Stock availability updated for matched object.`
    });

  } catch (err: any) {
    return sendError(res, "UPDATE_MENU_STOCK_FAILED", err.message, 500);
  }
});

export default router;
