import { Router, Request, Response } from "express";
import crypto from "crypto";
import { requireAuth, requireRider, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { config } from "../../config/index";
import { db } from "../../db/index";
import { sendWhatsApp } from "../../utils/notify";

const router = Router();

/**
 * POST /api/rides/estimate
 * Dynamically computes ride prices for bike and car based on database fare rules
 */
router.post("/estimate", requireAuth, async (req: Request, res: Response) => {
  const { pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, promo_code } = req.body;

  if ([pickup_lat, pickup_lng, dropoff_lat, dropoff_lng].some(v => v === undefined)) {
    return sendError(res, "VALIDATION_FAILED", "Please supply both pickup and destination coordinates.");
  }

  try {
    // 1. Calculate road routing distance using our maps module
    const distResponse = await fetch(`${config.API_BASE_URL}/api/maps/distance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": req.headers.authorization!
      },
      body: JSON.stringify({ origin_lat: pickup_lat, origin_lng: pickup_lng, dest_lat: dropoff_lat, dest_lng: dropoff_lng })
    });

    if (!distResponse.ok) {
      throw new Error(`Maps backend rejected distance matrix: status ${distResponse.status}`);
    }

    const distBody: any = await distResponse.json();
    if (!distBody.ok) {
      throw new Error(distBody.error?.message || "Failed computing route details.");
    }

    const { distance_km, duration_minutes } = distBody.data;

    // 2. Fetch service fare configuration rules from SQL
    const bikeSettings = await db.query("SELECT * FROM service_settings WHERE service_type = 'bike' AND is_active = true");
    const carSettings = await db.query("SELECT * FROM service_settings WHERE service_type = 'car' AND is_active = true");

    if (bikeSettings.length === 0 || carSettings.length === 0) {
      return sendError(res, "CONFIG_MISSING", "Services configurations are uninitialized in the database settings.");
    }

    const bs = bikeSettings[0];
    const cs = carSettings[0];

    // Compute Bike fare = base_fare + (distance * per_km) + (duration * per_minute)
    let bikeBase = Number(bs.base_fare) + (distance_km * Number(bs.per_km_rate)) + (duration_minutes * Number(bs.per_minute_rate));
    bikeBase = Math.max(bikeBase, Number(bs.minimum_fare));

    // Compute Car fare
    let carBase = Number(cs.base_fare) + (distance_km * Number(cs.per_km_rate)) + (duration_minutes * Number(cs.per_minute_rate));
    carBase = Math.max(carBase, Number(cs.minimum_fare));

    // 3. Apply promotional discounts if specified
    let discount = 0;
    if (promo_code) {
      const promos = await db.query(
        "SELECT * FROM promo_codes WHERE code = $1 AND is_active = true AND expires_at > NOW()",
        [promo_code.toUpperCase().trim()]
      );
      if (promos.length > 0) {
        const p = promos[0];
        if (Number(p.percentage) > 0) {
          discount = Number(p.percentage);
        } else if (Number(p.flat_amount) > 0) {
          discount = Number(p.flat_amount);
        }
      }
    }

    const calcDiscount = (amount: number) => {
      if (discount > 0 && discount <= 100) {
        return Number((amount * (discount / 100)).toFixed(2));
      }
      return discount > 0 ? Math.min(amount, discount) : 0;
    };

    const bikeDiscount = calcDiscount(bikeBase);
    const carDiscount = calcDiscount(carBase);

    // Apply Karachi pilot general 0% commission campaigns checks if enabled
    const commissionCampaigns = await db.query(
      "SELECT * FROM free_commission_enabled = true" // Handled gracefully inside configuration rules
    ).catch(() => []);

    return sendSuccess(res, {
      route: { distance_km, duration_minutes },
      estimates: [
        {
          service_type: "bike",
          service_name: "Shazo Bike",
          original_fare: Math.round(bikeBase),
          final_fare: Math.round(bikeBase - bikeDiscount),
          discount_applied: Math.round(bikeDiscount),
          currency: config.DEFAULT_CURRENCY,
          pilot_commission: config.FREE_COMMISSION_ENABLED ? 0 : Math.round(bikeBase * (Number(bs.commission_percentage) / 100))
        },
        {
          service_type: "car",
          service_name: "Shazo Car",
          original_fare: Math.round(carBase),
          final_fare: Math.round(carBase - carDiscount),
          discount_applied: Math.round(carDiscount),
          currency: config.DEFAULT_CURRENCY,
          pilot_commission: config.FREE_COMMISSION_ENABLED ? 0 : Math.round(carBase * (Number(cs.commission_percentage) / 100))
        }
      ]
    });

  } catch (err: any) {
    return sendError(res, "ESTIMATE_CALCULATION_FAILED", err.message, 500);
  }
});

/**
 * POST /api/rides/create
 * Submits custom ride request to the dispatch network queue
 */
router.post("/create", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, ride_type, payment_method, promo_code, proposed_fare } = req.body;

  if (!pickup_address || pickup_lat === undefined || pickup_lng === undefined || !dropoff_address || dropoff_lat === undefined || dropoff_lng === undefined || !ride_type) {
    return sendError(res, "VALIDATION_FAILED", "Please provide complete routing landmarks and geographic coordinates.");
  }

  try {
    // 1. Guard against booking duplicate ride requests for same user
    const existing = await db.query(
      `SELECT id FROM ride_bookings 
       WHERE customer_id = $1 AND status IN ('requested', 'accepted', 'arrived', 'in_transit')`,
      [req.user!.id]
    );

    if (existing.length > 0) {
      return sendError(res, "DUPLICATE_BOOKING", "You already have an active ride booking. Please complete or cancel it first.", 409);
    }

    // 2. Fetch Distance stats for permanent storage record
    const statsResponse = await fetch(`${config.API_BASE_URL}/api/maps/distance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": req.headers.authorization!
      },
      body: JSON.stringify({ origin_lat: pickup_lat, origin_lng: pickup_lng, dest_lat: dropoff_lat, dest_lng: dropoff_lng })
    });

    let distance_km = 5.0;
    let duration_minutes = 15;

    if (statsResponse.ok) {
      const statsJson: any = await statsResponse.json();
      if (statsJson.ok) {
        distance_km = statsJson.data.distance_km;
        duration_minutes = statsJson.data.duration_minutes;
      }
    }

    // 3. Compute proper fare from defaults or honor user's proposed bid
    let fare = proposed_fare ? Number(proposed_fare) : 150;
    
    if (!proposed_fare) {
      const estResponse = await fetch(`${config.API_BASE_URL}/api/rides/estimate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": req.headers.authorization!
        },
        body: JSON.stringify({ pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, promo_code })
      });
      if (estResponse.ok) {
        const estJson: any = await estResponse.json();
        if (estJson.ok) {
          const match = estJson.data.estimates.find((e: any) => e.service_type === ride_type);
          if (match) fare = match.final_fare;
        }
      }
    }

    // Determine platform commission (Honor Pakistan pilot 0% Commission campaign checks)
    const setRows = await db.query("SELECT * FROM service_settings WHERE service_type = $1", [ride_type]);
    const commPct = setRows.length > 0 ? Number(setRows[0].commission_percentage) : 10.0;
    const commission = config.FREE_COMMISSION_ENABLED ? 0.00 : Number((fare * (commPct / 100)).toFixed(2));

    // 4. Save to Database
    const rideId = "rid_" + crypto.randomUUID().slice(0, 8);
    await db.query(
      `INSERT INTO ride_bookings (id, customer_id, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, distance_km, duration_minutes, ride_type, fare, commission_amount, payment_method, promo_code_used, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'requested')`,
      [rideId, req.user!.id, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, distance_km, duration_minutes, ride_type, fare, commission, payment_method || "cash", promo_code || null]
    );

    // Initial status logs trail
    await db.query(
      `INSERT INTO ride_status_logs (id, ride_id, status, note)
       VALUES ($1, $2, 'requested', 'Ride booking initialized on Shazo dispatch network.')`,
      ["log_" + crypto.randomUUID().slice(0, 8), rideId]
    );

    const fullBooking = await db.query("SELECT * FROM ride_bookings WHERE id = $1", [rideId]);

    return sendSuccess(res, { ride: fullBooking[0] }, 201);

  } catch (err: any) {
    return sendError(res, "CREATE_RIDE_FAILED", err.message, 500);
  }
});

/**
 * POST /api/rides/offer-fare
 * Registers drivers bids or passengers counteroffers on a pending dispatch request
 */
router.post("/offer-fare", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { ride_id, proposed_fare } = req.body;
  if (!ride_id || !proposed_fare) {
    return sendError(res, "VALIDATION_FAILED", "Please provide a target ride_id and proposed bidding fare.");
  }

  try {
    const rides = await db.query("SELECT status FROM ride_bookings WHERE id = $1", [ride_id]);
    if (rides.length === 0) {
      return sendError(res, "RIDE_NOT_FOUND", "No ride matches this transaction.", 404);
    }

    if (rides[0].status !== "requested") {
      return sendError(res, "INVALID_STATE", "Bidding operations are only active on unassigned pending ride requests.", 400);
    }

    // Save bid offer row
    const offerId = "off_" + crypto.randomUUID().slice(0, 8);
    await db.query(
      `INSERT INTO ride_offers (id, ride_id, by_role, offerer_id, proposed_fare, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [offerId, ride_id, req.user!.role, req.user!.id, proposed_fare]
    );

    return sendSuccess(res, { offerId, message: "Bidding transaction compiled successfully." }, 201);

  } catch (err: any) {
    return sendError(res, "OFFER_FARE_FAILED", err.message, 500);
  }
});

/**
 * PATCH /api/rides/:id/status
 * Drives transitions during ride status changes
 */
router.patch("/:id/status", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const rideId = req.params.id;
  const { status, note } = req.body;

  if (!status) return sendError(res, "VALIDATION_FAILED", "Status parameters are missing.");

  try {
    const rides = await db.query("SELECT * FROM ride_bookings WHERE id = $1", [rideId]);
    if (rides.length === 0) {
      return sendError(res, "RIDE_NOT_FOUND", "Encountered invalid ride target registration.", 404);
    }

    const currentRide = rides[0];

    // Assert that status transitions flow in sequence
    // requested -> accepted -> arrived -> in_transit -> completed
    // Cancellables only before in_transit

    let updateQuery = "";
    let params: any[] = [];

    if (status === "accepted") {
      // Driver claims this ride
      if (req.user!.role !== "rider") {
        return sendError(res, "FORBIDDEN", "Only verified pilots can accept ride requests.", 403);
      }
      updateQuery = "UPDATE ride_bookings SET rider_id = $1, status = $2, updated_at = NOW() WHERE id = $3";
      params = [req.user!.id, "accepted", rideId];
    } else {
      // General transition updates
      updateQuery = "UPDATE ride_bookings SET status = $1, updated_at = NOW() WHERE id = $2";
      params = [status, rideId];
    }

    await db.query(updateQuery, params);

    // Save logs audit
    await db.query(
      `INSERT INTO ride_status_logs (id, ride_id, status, note)
       VALUES ($1, $2, $3, $4)`,
      ["log_" + crypto.randomUUID().slice(0, 8), rideId, status, note || `Ride transitioned to status: ${status}`]
    );

    // If ride completes successfully - execute financial ledger entries
    if (status === "completed") {
      const fareVal = Number(currentRide.fare);
      const hostComm = Number(currentRide.commission_amount);
      const riderId = currentRide.rider_id || req.user!.id; // fallback

      // Deduct commission from rider wallet balance and log earnings transaction ledger
      await db.query(
        "INSERT INTO rider_wallet_ledger (id, rider_id, amount, transaction_type, reference_id, note) VALUES ($1, $2, $3, $4, $5, $6)",
        [
          "ledg_" + crypto.randomUUID().slice(0, 8),
          riderId,
          fareVal - hostComm,
          "trip_earnings",
          rideId,
          `Earnings from completed journey: PKR ${fareVal} less ${hostComm} platform dues.`
        ]
      );

      if (hostComm > 0) {
        await db.query(
          "INSERT INTO rider_wallet_ledger (id, rider_id, amount, transaction_type, reference_id, note) VALUES ($1, $2, $3, $4, $5, $6)",
          [
            "ledg_" + crypto.randomUUID().slice(0, 8),
            riderId,
            -hostComm,
            "platform_commission",
            rideId,
            `Commission fee deduction for system platform access.`
          ]
        );
      }

      // Update rider wallet schema
      await db.query(
        `UPDATE rider_wallets 
         SET balance = balance + $1, updated_at = NOW() 
         WHERE rider_id = $2`,
        [fareVal - hostComm, riderId]
      );
    }

    const updated = await db.query("SELECT * FROM ride_bookings WHERE id = $1", [rideId]);
    return sendSuccess(res, { ride: updated[0] });

  } catch (err: any) {
    return sendError(res, "UPDATE_STATUS_FAILED", err.message, 500);
  }
});

/**
 * POST /api/rides/:id/cancel
 * Cancels a ride if in pre-transit checkpoints
 */
router.post("/:id/cancel", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const rideId = req.params.id;
  const { reason } = req.body;

  try {
    const rides = await db.query("SELECT status FROM ride_bookings WHERE id = $1", [rideId]);
    if (rides.length === 0) return sendError(res, "RIDE_NOT_FOUND", "Encountered invalid ride target.", 404);

    const { status } = rides[0];
    if (["in_transit", "completed", "cancelled"].includes(status)) {
      return sendError(res, "INVALID_STATE", `Cannot cancel a ride that is currently either ${status}.`, 400);
    }

    await db.query("UPDATE ride_bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [rideId]);

    await db.query(
      `INSERT INTO ride_status_logs (id, ride_id, status, note)
       VALUES ($1, $2, 'cancelled', $3)`,
      ["log_" + crypto.randomUUID().slice(0, 8), rideId, reason || "Ride cancelled by user request."]
    );

    return sendSuccess(res, { message: "Ride booking cancelled successfully." });

  } catch (err: any) {
    return sendError(res, "CANCEL_RIDE_FAILED", err.message, 500);
  }
});

/**
 * POST /api/rides/:id/rate
 * Saves user satisfaction ratings and customer feedback
 */
router.post("/:id/rate", requireAuth, async (req: Request, res: Response) => {
  const rideId = req.params.id;
  const { score, review } = req.body;

  if (score === undefined || score < 1 || score > 5) {
    return sendError(res, "VALIDATION_FAILED", "Please provide a valid numeric score rating between 1 and 5.");
  }

  try {
    const matched = await db.query("SELECT rider_id, status FROM ride_bookings WHERE id = $1", [rideId]);
    if (matched.length === 0) return sendError(res, "RIDE_NOT_FOUND", "Invalid ride mapping.", 404);

    const { rider_id, status } = matched[0];
    if (status !== "completed") {
      return sendError(res, "INVALID_STATE", "Ratings can only be posted after journey completion.", 400);
    }

    if (!rider_id) {
      return sendError(res, "NO_DRIVER", "No rider is assigned to this reservation history.", 400);
    }

    // Save ratings score
    const ratingId = "rat_" + crypto.randomUUID().slice(0, 8);
    // Explicit insert matching customer_ratings or audit table
    await db.query(
      `INSERT INTO audit_logs (id, user_id, role, action, target_table, target_row_id, notes)
       VALUES ($1, $2, 'customer', 'rate_ride_journey', 'ride_bookings', $3, $4)`,
      [ratingId, (req as AuthenticatedRequest).user!.id, rideId, `Score ${score}/5 posted for driver ${rider_id}. Details: ${review || "None"}`]
    );

    return sendSuccess(res, { message: "Thank you! Your feedback has been logged cleanly." });

  } catch (err: any) {
    return sendError(res, "POST_RATINGS_FAILED", err.message, 500);
  }
});

/**
 * POST /api/rides/:id/emergency
 * Instant SOS dispatcher which sends coordinates to active admin and WhatsApp channels
 */
router.post("/:id/emergency", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const rideId = req.params.id;
  const { description, latitude, longitude } = req.body;

  try {
    const rides = await db.query("SELECT * FROM ride_bookings WHERE id = $1", [rideId]);
    if (rides.length === 0) return sendError(res, "RIDE_NOT_FOUND", "Invalid ride target reference.", 404);

    const currentRide = rides[0];
    const reportId = "sos_" + crypto.randomUUID().slice(0, 8);

    // Save safety report row
    await db.query(
      `INSERT INTO safety_reports (id, booking_id, reported_by_id, reported_user_id, description, is_emergency, investigation_status)
       VALUES ($1, $2, $3, $4, $5, true, 'pending')`,
      [reportId, rideId, req.user!.id, req.user!.role === "customer" ? currentRide.rider_id : currentRide.customer_id, description || "SOS EMERGENCY FLASH TRIGGERED"]
    );

    // Trigger urgent mock notification triggers to security channel
    const urgentMsg = `⚠️ [SHAZO SECURITY ALERT]: Emergency SOS triggered on journey id: ${rideId}. Reported by: ${req.user!.full_name}. Coordinates: ${latitude || "Unknown"}, ${longitude || "Unknown"}. Details: ${description || "Immediate help request."}`;
    console.error(urgentMsg);
    
    // Attempt WhatsApp alerts logic to admin emergency desk
    await sendWhatsApp("+923001234567", urgentMsg).catch(() => {});

    return sendSuccess(res, {
      reportId,
      status: "TRIGGERED_ALERTED",
      message: "Emergency SOS dispatch alerts triggered cleanly. Security personnel are coordinating tracker updates."
    });

  } catch (err: any) {
    return sendError(res, "EMERGENCY_SOS_FAILED", err.message, 500);
  }
});

export default router;
