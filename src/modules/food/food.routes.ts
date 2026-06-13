import { Router, Request, Response } from "express";
import crypto from "crypto";
import { requireAuth, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { config } from "../../config/index";
import { db } from "../../db/index";

const router = Router();

/**
 * GET /api/food/restaurants
 * Retrieves list of active restaurants
 */
router.get("/restaurants", requireAuth, async (req: Request, res: Response) => {
  try {
    const outlets = await db.query("SELECT * FROM restaurant_profiles WHERE is_active = true ORDER BY rating DESC");
    return sendSuccess(res, { restaurants: outlets });
  } catch (err: any) {
    return sendError(res, "FETCH_RESTAURANTS_FAILED", err.message, 500);
  }
});

/**
 * GET /api/food/restaurants/:id/menu
 * Retrieves structured categories and menu items of a specific kitchen
 */
router.get("/restaurants/:id/menu", requireAuth, async (req: Request, res: Response) => {
  const restaurantId = req.params.id;

  try {
    const categories = await db.query(
      `SELECT * FROM restaurant_menu_categories 
       WHERE restaurant_id = $1 
       ORDER BY display_order ASC`,
      [restaurantId]
    );

    const menuItems = await db.query(
      `SELECT mi.* FROM restaurant_menu_items mi
       JOIN restaurant_menu_categories mc ON mi.category_id = mc.id
       WHERE mc.restaurant_id = $1 AND mi.is_available = true
       ORDER BY mi.created_at DESC`,
      [restaurantId]
    );

    return sendSuccess(res, {
      categories,
      menu_items: menuItems
    });

  } catch (err: any) {
    return sendError(res, "FETCH_MENU_FAILED", err.message, 500);
  }
});

/**
 * GET /api/food/cart
 * Retrieves the user's active shopping cart
 */
router.get("/cart", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const carts = await db.query("SELECT id, restaurant_id FROM carts WHERE user_id = $1", [req.user!.id]);
    if (carts.length === 0) {
      return sendSuccess(res, { cart: null });
    }

    const currentCart = carts[0];
    const items = await db.query(
      `SELECT ci.id as cart_item_id, ci.quantity, mi.* 
       FROM cart_items ci
       JOIN restaurant_menu_items mi ON ci.menu_item_id = mi.id
       WHERE ci.cart_id = $1`,
      [currentCart.id]
    );

    return sendSuccess(res, {
      cart: {
        id: currentCart.id,
        restaurant_id: currentCart.restaurant_id,
        items
      }
    });

  } catch (err: any) {
    return sendError(res, "FETCH_CART_FAILED", err.message, 500);
  }
});

/**
 * POST /api/food/cart
 * Updates, appends, or clears item objects synchronously inside database cart tables
 */
router.post("/cart", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { restaurant_id, items } = req.body; // items array format: [{ menuItemId, quantity }]

  if (!items || !Array.isArray(items)) {
    return sendError(res, "VALIDATION_FAILED", "Please supply an items array configuration.");
  }

  try {
    let carts = await db.query("SELECT id FROM carts WHERE user_id = $1", [req.user!.id]);
    let cartId = "";

    if (carts.length === 0) {
      cartId = "crt_" + crypto.randomUUID().slice(0, 8);
      await db.query(
        "INSERT INTO carts (id, user_id, restaurant_id) VALUES ($1, $2, $3)",
        [cartId, req.user!.id, restaurant_id || null]
      );
    } else {
      cartId = carts[0].id;
      await db.query(
        "UPDATE carts SET restaurant_id = COALESCE($1, restaurant_id), updated_at = NOW() WHERE id = $2",
        [restaurant_id || null, cartId]
      );
    }

    // Rewrite relational records on cart_items table
    await db.query("DELETE FROM cart_items WHERE cart_id = $1", [cartId]);

    for (const item of items) {
      if (item.quantity > 0) {
        await db.query(
          "INSERT INTO cart_items (id, cart_id, menu_item_id, quantity) VALUES ($1, $2, $3, $4)",
          ["ci_" + crypto.randomUUID().slice(0, 8), cartId, item.menuItemId, item.quantity]
        );
      }
    }

    // Return reconstituted cart
    const refreshed = await fetch(`${config.API_BASE_URL}/api/food/cart`, {
      headers: { "Authorization": req.headers.authorization! }
    });
    const refreshedJson: any = await refreshed.json();
    return res.status(200).json(refreshedJson);

  } catch (err: any) {
    return sendError(res, "UPDATE_CART_FAILED", err.message, 500);
  }
});

/**
 * POST /api/food/order
 * Submits structured kitchen orders to matching vendor nodes
 */
router.post("/order", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { restaurant_id, delivery_address, delivery_lat, delivery_lng, delivery_instructions, payment_method } = req.body;

  if (!restaurant_id || !delivery_address || delivery_lat === undefined || delivery_lng === undefined) {
    return sendError(res, "VALIDATION_FAILED", "Please provide restaurant_id, address, and coordinates.");
  }

  try {
    // 1. Obtain items list from user's current database cart
    const cartDetailsResponse = await fetch(`${config.API_BASE_URL}/api/food/cart`, {
      headers: { "Authorization": req.headers.authorization! }
    });
    const cJson: any = await cartDetailsResponse.json();

    if (!cJson.ok || !cJson.data?.cart?.items || cJson.data.cart.items.length === 0) {
      return sendError(res, "EMPTY_CART", "Your cart is empty. Cannot checkout an empty container.", 400);
    }

    const { items } = cJson.data.cart;

    // 2. Validate menu pricing lists and compute subtotal
    let subtotal = 0;
    for (const raw of items) {
      subtotal += Number(raw.price) * Number(raw.quantity);
    }

    // 3. Compute dynamic delivery fee using maps distance formulas
    // Fetch Restaurant Profile to locate kitchen coordinates
    const rProfiles = await db.query("SELECT latitude, longitude FROM restaurant_profiles WHERE id = $1", [restaurant_id]);
    if (rProfiles.length === 0) {
      return sendError(res, "RESTAURANT_INVALID", "Target restaurant is unrecognized on this platform.", 404);
    }

    const kitchen = rProfiles[0];
    const mapStatsResponse = await fetch(`${config.API_BASE_URL}/api/maps/distance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": req.headers.authorization!
      },
      body: JSON.stringify({
        origin_lat: kitchen.latitude,
        origin_lng: kitchen.longitude,
        dest_lat: delivery_lat,
        dest_lng: delivery_lng
      })
    });

    let distance_km = 4.0;
    if (mapStatsResponse.ok) {
      const msBody: any = await mapStatsResponse.json();
      if (msBody.ok) distance_km = msBody.data.distance_km;
    }

    // Delivery fee = base delivery + per_km logic
    const foodRates = await db.query("SELECT * FROM service_settings WHERE service_type = 'food_delivery'");
    const baseFee = foodRates.length > 0 ? Number(foodRates[0].base_fare) : 50.0;
    const perKm = foodRates.length > 0 ? Number(foodRates[0].per_km_rate) : 20.0;
    
    const deliveryFee = Number((baseFee + distance_km * perKm).toFixed(2));
    const grandTotal = subtotal + deliveryFee;

    // Platform commission rules
    const commPct = foodRates.length > 0 ? Number(foodRates[0].commission_percentage) : 15.0;
    const commission = config.FREE_COMMISSION_ENABLED ? 0.00 : Number((subtotal * (commPct / 100)).toFixed(2));

    // 4. Commit Order block inside SQL
    const orderId = "ord_" + crypto.randomUUID().slice(0, 8);
    await db.query(
      `INSERT INTO food_orders (id, customer_id, restaurant_id, delivery_address, delivery_lat, delivery_lng, delivery_instructions, items_total, delivery_fee, commission_amount, grand_total, payment_method, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ordered')`,
      [orderId, req.user!.id, restaurant_id, delivery_address, delivery_lat, delivery_lng, delivery_instructions || "", subtotal, deliveryFee, commission, grandTotal, payment_method || "cash"]
    );

    // Write specific item details rows
    for (const item of items) {
      await db.query(
        `INSERT INTO food_order_items (id, order_id, menu_item_id, name, price, quantity)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ["foi_" + crypto.randomUUID().slice(0, 8), orderId, item.id, item.name, item.price, item.quantity]
      );
    }

    // Flush/Clear User's cart database state
    await db.query("DELETE FROM cart_items WHERE cart_id = $1", [cJson.data.cart.id]);

    const ordDetails = await db.query("SELECT * FROM food_orders WHERE id = $1", [orderId]);

    return sendSuccess(res, {
      order: ordDetails[0],
      items
    }, 201);

  } catch (err: any) {
    return sendError(res, "SUBMIT_FOOD_ORDER_FAILED", err.message, 500);
  }
});

/**
 * GET /api/food/orders/:id
 * Tracks state of particular kitchen dispatches
 */
router.get("/orders/:id", requireAuth, async (req: Request, res: Response) => {
  const orderId = req.params.id;

  try {
    const orders = await db.query("SELECT * FROM food_orders WHERE id = $1", [orderId]);
    if (orders.length === 0) {
      return sendError(res, "ORDER_NOT_FOUND", "No food order matches this transaction.", 404);
    }

    const items = await db.query("SELECT * FROM food_order_items WHERE order_id = $1", [orderId]);

    return sendSuccess(res, {
      order: orders[0],
      items
    });

  } catch (err: any) {
    return sendError(res, "TRACK_ORDER_FAILED", err.message, 500);
  }
});

export default router;
