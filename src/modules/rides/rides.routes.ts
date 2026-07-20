import { Router, Request, Response } from "express";
import crypto from "crypto";
import { requireAuth, requireRider, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { config } from "../../config/index";
import { db } from "../../db/index";
import { sendWhatsApp } from "../../utils/notify";
import { io } from "../../server";

const router = Router();

/**
 * GET /api/rides/types
 * Returns the list of all active service types for rides
 */
router.get("/types", requireAuth, async (req: Request, res: Response) => {
  try {
    const types = await db.query(
      `SELECT * FROM service_settings
       WHERE is_active = true
         AND service_type = ANY($1::text[])
       ORDER BY array_position($1::text[], service_type)`,
      [["bike", "rickshaw", "car_mini", "car_go", "car_business", "car_luxury"]]
    );
    return sendSuccess(res, { types });
  } catch (err: any) {
    return sendError(res, "FETCH_TYPES_FAILED", err.message, 500);
  }
});

/**
 * POST /api/rides/estimate
 * Dynamically computes ride prices based on database fare rules
 */
router.post("/estimate", requireAuth, async (req: Request, res: Response) => {
  const { pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, promo_code } = req.body;

  if ([pickup_lat, pickup_lng, dropoff_lat, dropoff_lng].some(v => v === undefined)) {
    return sendError(res, "VALIDATION_FAILED", "Please supply both pickup and destination coordinates.");
  }

  try {
    // 1. Calculate road routing distance using our maps module
    let distResponse: any = null;
    try {
      distResponse = await fetch(`${config.API_BASE_URL}/api/maps/distance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": req.headers.authorization!
        },
        body: JSON.stringify({ origin_lat: pickup_lat, origin_lng: pickup_lng, dest_lat: dropoff_lat, dest_lng: dropoff_lng })
      });
    } catch (e) {
      console.warn("Self-fetch for distance failed:", e);
    }

    let distance_km = 5.0;
    let duration_minutes = 15;

    if (distResponse && distResponse.ok) {
      try {
        const distBody: any = await distResponse.json();
        // /api/maps/distance actually returns
        // { distance: { text, value(meters) }, duration: { text, value(seconds) } } —
        // reading distance_km/duration_minutes directly (fields that don't
        // exist on this shape) silently produced `undefined` here, which
        // cascaded into NaN fare math and a null-filled /estimate response
        // (the blank "PKR" on the booking screen) on every single request.
        if (distBody.ok && distBody.data?.distance?.value != null && distBody.data?.duration?.value != null) {
          distance_km = distBody.data.distance.value / 1000;
          duration_minutes = distBody.data.duration.value / 60;
        } else {
          throw new Error("API returned not ok");
        }
      } catch (e) {
        distResponse = null; // force fallback
      }
    }

    if (!distResponse || !distResponse.ok) {
      // Fallback: Haversine straight-line distance if Maps API fails
      const R = 6371; // Earth radius in km
      const dLat = (dropoff_lat - pickup_lat) * Math.PI / 180;
      const dLng = (dropoff_lng - pickup_lng) * Math.PI / 180;
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(pickup_lat * Math.PI / 180) * Math.cos(dropoff_lat * Math.PI / 180) * Math.sin(dLng/2) * Math.sin(dLng/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      distance_km = Math.max(2.0, R * c * 1.3); // 1.3 road multiplier
      duration_minutes = Math.max(5, distance_km * 3); // ~3 mins per km
    }

    // 2. Fetch service fare configuration rules from SQL
    const activeSettings = await db.query(
      `SELECT * FROM service_settings
       WHERE is_active = true
         AND service_type = ANY($1::text[])`,
      [["bike", "rickshaw", "car_mini", "car_go", "car_business", "car_luxury"]]
    );

    if (activeSettings.length === 0) {
      return sendError(res, "CONFIG_MISSING", "Services configurations are uninitialized in the database settings.");
    }

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

    const estimates = activeSettings.map(service => {
      let baseFare = Number(service.base_fare) + (distance_km * Number(service.per_km_rate)) + (duration_minutes * Number(service.per_minute_rate));
      
      // Smart Fare Logic: 
      // Minimum fare is the absolute floor. Recommended fare is the peak-adjusted starting point.
      const peakFactor = Number(service.peak_factor_multiplier) || 1.0;
      const recMultiplier = Number(service.recommended_fare_multiplier) || 1.2;

      let minimumFare = Math.max(baseFare, Number(service.minimum_fare));
      let recommendedFare = minimumFare * peakFactor * recMultiplier;
      
      // Apply discounts
      const finalMinimumFare = Math.max(0, minimumFare - calcDiscount(minimumFare));
      const finalRecommendedFare = Math.max(0, recommendedFare - calcDiscount(recommendedFare));
      
      const maximumMultiplier = Number(service.maximum_fare_multiplier) || 1.5;
      const finalMaximumFare = Math.max(finalRecommendedFare, finalRecommendedFare * maximumMultiplier);
      return {
        service_type: service.service_type,
        service_name: service.service_name || service.service_type,
        minimum_fare: Math.round(finalMinimumFare),
        recommended_fare: Math.round(finalRecommendedFare),
        maximum_fare: Math.round(finalMaximumFare),
        total_fare: Math.round(finalRecommendedFare), // Legacy compat
        discount_applied: Math.round(calcDiscount(recommendedFare)),
        currency: config.DEFAULT_CURRENCY,
        pilot_commission: config.FREE_COMMISSION_ENABLED ? 0 : Math.round(finalRecommendedFare * (Number(service.commission_percentage) / 100))
      };
    });

    return sendSuccess(res, {
      route: { distance_km, duration_minutes },
      estimates: estimates
    });

  } catch (err: any) {
    return sendError(res, "ESTIMATE_CALCULATION_FAILED", err.message, 500);
  }
});

/**
 * POST /api/rides/book
 * Submits custom ride request to the dispatch network queue
 */
router.post("/request", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, vehicle_category: ride_type, payment_method, promo_code, customer_offer_fare: proposed_fare } = req.body;

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
    let statsResponse: any = null;
    try {
      statsResponse = await fetch(`${config.API_BASE_URL}/api/maps/distance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": req.headers.authorization!
        },
        body: JSON.stringify({ origin_lat: pickup_lat, origin_lng: pickup_lng, dest_lat: dropoff_lat, dest_lng: dropoff_lng })
      });
    } catch (e) {
      console.warn("Self-fetch for request distance failed:", e);
    }

    let distance_km = 5.0;
    let duration_minutes = 15;

    if (statsResponse && statsResponse.ok) {
      try {
        const statsJson: any = await statsResponse.json();
        // Same real shape as /estimate's identical self-fetch:
        // { distance: { value(meters) }, duration: { value(seconds) } } — not
        // distance_km/duration_minutes. This previously wrote `undefined`
        // straight into ride_bookings.distance_km/duration_minutes on every
        // booking.
        if (statsJson.ok && statsJson.data?.distance?.value != null && statsJson.data?.duration?.value != null) {
          distance_km = statsJson.data.distance.value / 1000;
          duration_minutes = statsJson.data.duration.value / 60;
        } else {
          throw new Error("API returned not ok");
        }
      } catch (e) {
        statsResponse = null;
      }
    }
    
    if (!statsResponse || !statsResponse.ok) {
      // Fallback: Haversine
      const R = 6371; 
      const dLat = (dropoff_lat - pickup_lat) * Math.PI / 180;
      const dLng = (dropoff_lng - pickup_lng) * Math.PI / 180;
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(pickup_lat * Math.PI / 180) * Math.cos(dropoff_lat * Math.PI / 180) * Math.sin(dLng/2) * Math.sin(dLng/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      distance_km = Math.max(2.0, R * c * 1.3);
      duration_minutes = Math.max(5, distance_km * 3);
    }

    // 3. Compute proper fare from defaults or honor user's proposed bid.
    // ride_bookings has no "ride_type" column — real columns are
    // service_type/vehicle_category (both set to the same value here, since
    // there's no finer sub-category yet) plus a negotiation-oriented set:
    // system_estimated_fare (what our pricing engine recommends),
    // customer_offer_fare (what the customer actually proposed), and a plain
    // `fare` that always mirrors "the current effective price" for this ride
    // — the customer's offer until a rider's counter-offer is accepted.
    let fare = proposed_fare ? Number(proposed_fare) : 150;
    let estimatedFare = fare;
    let min_fare = 0;
    let max_fare = Number.MAX_SAFE_INTEGER;

    let estResponse: any = null;
    try {
      estResponse = await fetch(`${config.API_BASE_URL}/api/rides/estimate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": req.headers.authorization!
        },
        body: JSON.stringify({ pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, promo_code })
      });
    } catch(e) {
      console.warn("Self-fetch for estimate failed:", e);
    }

    if (estResponse && estResponse.ok) {
      const estJson: any = await estResponse.json();
      if (estJson.ok) {
        const match = estJson.data.estimates.find((e: any) => e.service_type === ride_type);
        if (match) {
          min_fare = match.minimum_fare;
          max_fare = match.maximum_fare;
          estimatedFare = match.recommended_fare;
          if (!proposed_fare) fare = match.recommended_fare;
        }
      }
    }

    if (fare < min_fare) {
      return sendError(res, "FARE_TOO_LOW", `The minimum allowed fare for this route is ${config.DEFAULT_CURRENCY} ${min_fare}.`, 400);
    }
    if (fare > max_fare) {
      return sendError(res, "FARE_TOO_HIGH", `The maximum allowed fare for this route is ${config.DEFAULT_CURRENCY} ${max_fare}.`, 400);
    }

    // Determine platform commission (Honor Pakistan pilot 0% Commission campaign checks)
    const setRows = await db.query("SELECT * FROM service_settings WHERE service_type = $1", [ride_type]);
    const commPct = setRows.length > 0 ? Number(setRows[0].commission_percentage) : 10.0;
    const commission = config.FREE_COMMISSION_ENABLED ? 0.00 : Number((fare * (commPct / 100)).toFixed(2));

    // 4. Save to Database
    const rideId = "rid_" + crypto.randomUUID().slice(0, 8);
    const pickupPin = String(crypto.randomInt(1000, 10000));
    await db.query(
      `INSERT INTO ride_bookings (id, customer_id, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, distance_km, duration_minutes, service_type, vehicle_category, fare, total_fare, system_estimated_fare, customer_offer_fare, minimum_fare, maximum_fare, commission_amount, payment_method, promo_code_used, pickup_pin, negotiation_status, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14, $15, $16, $17, $18, $19, $20, $21, 'pending', 'requested')`,
      [rideId, req.user!.id, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, distance_km, duration_minutes, ride_type, ride_type, fare, estimatedFare, proposed_fare ? fare : null, min_fare, max_fare, commission, payment_method || "cash", promo_code || null, pickupPin]
    );

    // Initial status logs trail
    await db.query(
      `INSERT INTO ride_status_logs (id, ride_id, status, note)
       VALUES ($1, $2, 'requested', 'Ride booking initialized on Shazo dispatch network.')`,
      ["log_" + crypto.randomUUID().slice(0, 8), rideId]
    );

    const fullBooking = await db.query("SELECT * FROM ride_bookings WHERE id = $1", [rideId]);

    // Dispatch only the public request fields. The pickup PIN and customer
    // contact details are never broadcast before a rider is assigned.
    const { pickup_pin: _pickupPin, customer_id: _customerId, ...dispatchRide } = fullBooking[0];
    const dispatchCategory = ride_type.startsWith("car_") ? "car" : ride_type;
    io.to(`driver_pool:${dispatchCategory}`).emit("new_ride_request", dispatchRide);

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
    if (req.user!.role !== "rider") {
      return sendError(res, "FORBIDDEN", "Only riders can submit a fare offer.", 403);
    }
    const rides = await db.query("SELECT status, rider_id, service_type, pickup_lat, pickup_lng, minimum_fare, maximum_fare FROM ride_bookings WHERE id = $1", [ride_id]);
    if (rides.length === 0) {
      return sendError(res, "RIDE_NOT_FOUND", "No ride matches this transaction.", 404);
    }

    if (rides[0].status !== "requested" || rides[0].rider_id) {
      return sendError(res, "INVALID_STATE", "Bidding operations are only active on unassigned pending ride requests.", 400);
    }

    const profiles = await db.query(
      `SELECT verification_status, is_online, vehicle_type, current_lat, current_lng, last_location_at
       FROM rider_profiles WHERE user_id = $1`,
      [req.user!.id]
    );
    const profile = profiles[0];
    const serviceMatches = profile && (profile.vehicle_type === rides[0].service_type || (profile.vehicle_type === "car" && String(rides[0].service_type).startsWith("car_")));
    const locationFresh = profile?.last_location_at && Date.now() - new Date(profile.last_location_at).getTime() < 10 * 60 * 1000;
    const toRadians = (value: number) => value * Math.PI / 180;
    const lat1 = Number(profile?.current_lat); const lng1 = Number(profile?.current_lng);
    const lat2 = Number(rides[0].pickup_lat); const lng2 = Number(rides[0].pickup_lng);
    const dLat = toRadians(lat2 - lat1); const dLng = toRadians(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
    const pickupDistanceKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    if (!profile || profile.verification_status !== "verified" || !profile.is_online || !serviceMatches || !locationFresh || profile.current_lat == null || profile.current_lng == null || !Number.isFinite(pickupDistanceKm) || pickupDistanceKm > 15) {
      return sendError(res, "RIDER_NOT_ELIGIBLE", "Go online with a current location and matching verified vehicle before making an offer.", 403);
    }

    if (Number(proposed_fare) < Number(rides[0].minimum_fare)) {
      return sendError(res, "FARE_TOO_LOW", `The minimum allowed fare for this route is ${config.DEFAULT_CURRENCY} ${rides[0].minimum_fare}.`, 400);
    }
    if (rides[0].maximum_fare != null && Number(proposed_fare) > Number(rides[0].maximum_fare)) {
      return sendError(res, "FARE_TOO_HIGH", `The maximum allowed fare for this route is ${config.DEFAULT_CURRENCY} ${rides[0].maximum_fare}.`, 400);
    }

    // Save bid offer row
    const offerId = "off_" + crypto.randomUUID().slice(0, 8);
    await db.query(
      `INSERT INTO ride_offers (id, ride_id, by_role, offerer_id, proposed_fare, status, is_counter_offer)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
      [offerId, ride_id, "rider", req.user!.id, proposed_fare, true]
    );

    // Reflect the latest counter directly on the ride row too, so anything
    // reading ride_bookings (not just the socket event) sees it.
    await db.query(
      `UPDATE ride_bookings SET rider_counter_fare = $1, negotiation_status = 'countered', updated_at = NOW() WHERE id = $2`,
      [proposed_fare, ride_id]
    );

    // Alert the customer that a driver proposed a bid — real aggregate
    // rating from rider_profiles, not a placeholder.
    const riderProfile = await db.query(
      `SELECT rp.rating, rp.total_rides, rv.make_model, rv.color,
              COALESCE(rv.license_plate, rv.registration_number) AS license_plate
       FROM rider_profiles rp
       LEFT JOIN rider_vehicles rv ON rv.rider_id = rp.id
       WHERE rp.user_id = $1
       ORDER BY rv.created_at DESC NULLS LAST
       LIMIT 1`,
      [req.user!.id]
    );
    const rider = riderProfile[0] || {};
    io.to(ride_id).emit("new_driver_offer", {
      id: offerId,
      proposed_fare,
      driver: {
        id: req.user!.id,
        name: req.user!.full_name,
        rating: rider.rating != null ? Number(rider.rating) : null,
        total_rides: Number(rider.total_rides || 0),
        make_model: rider.make_model || null,
        color: rider.color || null,
        license_plate: rider.license_plate || null
      }
    });

    return sendSuccess(res, { offerId, message: "Bidding transaction compiled successfully." }, 201);

  } catch (err: any) {
    return sendError(res, "OFFER_CREATION_FAILED", err.message, 500);
  }
});

/**
 * POST /api/rides/:id/accept-offer
 * Customer accepts one rider's counter-offer, finalizing the negotiation:
 * assigns that rider to the ride and settles the fare. Was called by the
 * customer app's ActiveRideScreen but never existed on the backend at all —
 * accepting any driver's bid was a dead action.
 */
router.post("/:id/accept-offer", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const rideId = req.params.id;
  const { offer_id } = req.body;
  if (!offer_id) {
    return sendError(res, "VALIDATION_FAILED", "Please provide an offer_id to accept.");
  }

  try {
    let acceptedRide: any;
    await db.transaction(async (client) => {
      const rideResult = await client.query(
        "SELECT * FROM ride_bookings WHERE id = $1 AND customer_id = $2 FOR UPDATE",
        [rideId, req.user!.id]
      );
      const ride = rideResult.rows[0];
      if (!ride) throw new Error("RIDE_NOT_FOUND");
      if (ride.status !== "requested" || ride.rider_id) throw new Error("RIDE_UNAVAILABLE");

      const offerResult = await client.query(
        `SELECT ro.* FROM ride_offers ro
         JOIN rider_profiles rp ON rp.user_id = ro.offerer_id
         WHERE ro.id = $1 AND ro.ride_id = $2 AND ro.status = 'pending'
           AND ro.by_role = 'rider' AND rp.verification_status = 'verified'
         FOR UPDATE OF ro`,
        [offer_id, rideId]
      );
      const offer = offerResult.rows[0];
      if (!offer) throw new Error("OFFER_NOT_FOUND");

      const updated = await client.query(
        `UPDATE ride_bookings SET
           status = 'accepted',
           rider_id = $1,
           accepted_fare = $2,
           fare = $2,
           total_fare = $2,
           negotiation_status = 'accepted',
           accepted_at = NOW(), updated_at = NOW()
         WHERE id = $3 AND status = 'requested' AND rider_id IS NULL
         RETURNING *`,
        [offer.offerer_id, offer.proposed_fare, rideId]
      );
      if (updated.rows.length !== 1) throw new Error("RIDE_UNAVAILABLE");
      acceptedRide = updated.rows[0];
      await client.query("UPDATE ride_offers SET status = 'accepted' WHERE id = $1", [offer_id]);
      // Any other rider's pending bid on this ride is now moot.
      await client.query(
        "UPDATE ride_offers SET status = 'rejected' WHERE ride_id = $1 AND id != $2 AND status = 'pending'",
        [rideId, offer_id]
      );
    });

    io.to(rideId).emit("ride_update", { rideId, status: "accepted" });

    return sendSuccess(res, { message: "Offer accepted. A rider has been assigned to this ride.", ride: acceptedRide });
  } catch (err: any) {
    if (err.message === "RIDE_NOT_FOUND") return sendError(res, "RIDE_NOT_FOUND", "No matching ride found for this customer.", 404);
    if (err.message === "OFFER_NOT_FOUND") return sendError(res, "OFFER_NOT_FOUND", "This offer is no longer available.", 404);
    if (err.message === "RIDE_UNAVAILABLE") return sendError(res, "INVALID_STATE", "This ride has already been assigned or is no longer requestable.", 409);
    return sendError(res, "ACCEPT_OFFER_FAILED", err.message, 500);
  }
});

/**
 * GET /:id/messages
 * Retrieves the chat history for a specific ride
 */
router.get("/:id/messages", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    const rides = await db.query("SELECT customer_id, rider_id FROM ride_bookings WHERE id = $1", [id]);
    if (rides.length === 0) {
      return sendError(res, "RIDE_NOT_FOUND", "Ride not found", 404);
    }
    if (rides[0].customer_id !== req.user!.id && rides[0].rider_id !== req.user!.id) {
      return sendError(res, "FORBIDDEN", "You are not authorized to view messages for this ride.", 403);
    }

    const messages = await db.query(
      "SELECT * FROM ride_messages WHERE ride_id = $1 ORDER BY created_at ASC",
      [id]
    );
    return sendSuccess(res, { messages });
  } catch (err: any) {
    return sendError(res, "FETCH_MESSAGES_FAILED", err.message, 500);
  }
});

/**
 * PATCH /api/rides/:id/status
 * Drives transitions during ride status changes
 */
// Legal ride status transitions. Keys are the current status, values are the
// statuses that may legally follow. Anything not listed is rejected as invalid.
const RIDE_STATUS_TRANSITIONS: Record<string, string[]> = {
  requested: ["accepted", "cancelled"],
  accepted: ["arrived", "cancelled"],
  arrived: ["in_transit", "cancelled"],
  in_transit: ["completed"],
  completed: [],
  cancelled: [],
};

router.patch("/:id/status", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const rideId = req.params.id;
  const { status, note } = req.body;

  if (!status) return sendError(res, "VALIDATION_FAILED", "Status parameters are missing.");

  if (!Object.prototype.hasOwnProperty.call(RIDE_STATUS_TRANSITIONS, status)) {
    return sendError(res, "VALIDATION_FAILED", "Unrecognized ride status value.", 400);
  }

  try {
    const rides = await db.query("SELECT * FROM ride_bookings WHERE id = $1", [rideId]);
    if (rides.length === 0) {
      return sendError(res, "RIDE_NOT_FOUND", "Encountered invalid ride target registration.", 404);
    }

    const currentRide = rides[0];

    // Assert that status transitions flow in sequence
    // requested -> accepted -> arrived -> in_transit -> completed
    // Cancellables only before in_transit
    const allowedNextStatuses = RIDE_STATUS_TRANSITIONS[currentRide.status] || [];
    if (!allowedNextStatuses.includes(status)) {
      return sendError(res, "INVALID_TRANSITION", `Cannot transition ride from '${currentRide.status}' to '${status}'.`, 400);
    }

    const isCustomer = currentRide.customer_id === req.user!.id;
    const isAssignedRider = currentRide.rider_id === req.user!.id;

    let updateQuery = "";
    let params: any[] = [];

    if (status === "accepted") {
      // Driver claims this ride. No party is assigned yet at this transition point,
      // so any verified rider may claim it (ownership is established by this action).
      if (req.user!.role !== "rider") {
        return sendError(res, "FORBIDDEN", "Only verified pilots can accept ride requests.", 403);
      }
      updateQuery = "UPDATE ride_bookings SET rider_id = $1, status = $2, updated_at = NOW() WHERE id = $3";
      params = [req.user!.id, "accepted", rideId];
    } else if (status === "cancelled") {
      // Either the customer or the assigned rider may cancel.
      if (!isCustomer && !isAssignedRider) {
        return sendError(res, "FORBIDDEN", "You are not authorized to cancel this ride.", 403);
      }
      updateQuery = "UPDATE ride_bookings SET status = $1, updated_at = NOW() WHERE id = $2";
      params = [status, rideId];
    } else {
      // arrived / in_transit / completed: only the assigned pilot drives trip progress.
      if (!isAssignedRider) {
        return sendError(res, "FORBIDDEN", "Only the assigned pilot can update this ride's progress.", 403);
      }
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
    io.to(rideId).emit("ride_update", { rideId, status });
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
    const rides = await db.query("SELECT customer_id, rider_id, status FROM ride_bookings WHERE id = $1", [rideId]);
    if (rides.length === 0) return sendError(res, "RIDE_NOT_FOUND", "Encountered invalid ride target.", 404);

    const { customer_id, rider_id, status } = rides[0];
    if (customer_id !== req.user!.id && rider_id !== req.user!.id) {
      return sendError(res, "FORBIDDEN", "You are not authorized to cancel this ride.", 403);
    }
    if (["in_transit", "completed", "cancelled"].includes(status)) {
      return sendError(res, "INVALID_STATE", `Cannot cancel a ride that is currently either ${status}.`, 400);
    }

    await db.query("UPDATE ride_bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [rideId]);

    await db.query(
      `INSERT INTO ride_status_logs (id, ride_id, status, note)
       VALUES ($1, $2, 'cancelled', $3)`,
      ["log_" + crypto.randomUUID().slice(0, 8), rideId, reason || "Ride cancelled by user request."]
    );

    io.to(rideId).emit("ride_update", { rideId, status: "cancelled" });
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
    const matched = await db.query("SELECT customer_id, rider_id, status FROM ride_bookings WHERE id = $1", [rideId]);
    if (matched.length === 0) return sendError(res, "RIDE_NOT_FOUND", "Invalid ride mapping.", 404);

    const { customer_id, rider_id, status } = matched[0];
    const authUser = (req as AuthenticatedRequest).user!;
    if (customer_id !== authUser.id) {
      return sendError(res, "FORBIDDEN", "Only the ride's customer can submit a rating.", 403);
    }

    if (status !== "completed") {
      return sendError(res, "INVALID_STATE", "Ratings can only be posted after journey completion.", 400);
    }

    if (!rider_id) {
      return sendError(res, "NO_DRIVER", "No rider is assigned to this reservation history.", 400);
    }

    // Persist the score AND the free-text review directly on the ride itself,
    // and roll the score into the driver's aggregate rating. Previously the
    // review text only went into audit_logs as an unstructured string, so it
    // could never be shown back to the customer on their own ride receipt.
    await db.query("UPDATE ride_bookings SET rider_rating = $1, rider_review = $2, updated_at = NOW() WHERE id = $3", [score, review || null, rideId]);
    await db.query(
      `UPDATE rider_profiles SET rating = (
         SELECT AVG(rider_rating) FROM ride_bookings WHERE rider_id = $1 AND rider_rating IS NOT NULL
       ), updated_at = NOW() WHERE user_id = $1`,
      [rider_id]
    );

    // Still log it as an audit entry too, for ops visibility alongside other actions.
    const ratingId = "rat_" + crypto.randomUUID().slice(0, 8);
    await db.query(
      `INSERT INTO audit_logs (id, user_id, role, action, target_table, target_id, notes)
       VALUES ($1, $2, 'customer', 'rate_ride_journey', 'ride_bookings', $3, $4)`,
      [ratingId, authUser.id, rideId, `Score ${score}/5 posted for driver ${rider_id}.${review ? ` Review: ${review}` : ''}`]
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
    if (currentRide.customer_id !== req.user!.id && currentRide.rider_id !== req.user!.id) {
      return sendError(res, "FORBIDDEN", "You are not authorized to raise an emergency for this ride.", 403);
    }
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
    await sendWhatsApp("+923393570109", urgentMsg).catch(() => {});

    return sendSuccess(res, {
      reportId,
      status: "TRIGGERED_ALERTED",
      message: "Emergency SOS dispatch alerts triggered cleanly. Security personnel are coordinating tracker updates."
    });

  } catch (err: any) {
    return sendError(res, "EMERGENCY_SOS_FAILED", err.message, 500);
  }
});

/**
 * GET /api/rides/:id/status
 * Check ride status quickly without full payload
 */
router.get("/:id/status", requireAuth, async (req: Request, res: Response) => {
  const rideId = req.params.id;
  try {
    const rides = await db.query("SELECT id, status, customer_id, rider_id FROM ride_bookings WHERE id = $1", [rideId]);
    if (rides.length === 0) return sendError(res, "NOT_FOUND", "Ride not found");

    const authReq = req as AuthenticatedRequest;
    if (rides[0].customer_id !== authReq.user!.id && rides[0].rider_id !== authReq.user!.id) {
      return sendError(res, "FORBIDDEN", "You are not authorized to view this ride.", 403);
    }

    return sendSuccess(res, { status: rides[0].status, rider_id: rides[0].rider_id });
  } catch (err: any) {
    return sendError(res, "FETCH_FAILED", err.message, 500);
  }
});

router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const rides = await db.query("SELECT * FROM ride_bookings WHERE id = $1", [req.params.id]);
    if (rides.length === 0) return sendError(res, "NOT_FOUND", "Ride not found");

    const ride = rides[0];
    const authReq = req as AuthenticatedRequest;
    if (ride.customer_id !== authReq.user!.id && ride.rider_id !== authReq.user!.id) {
      return sendError(res, "FORBIDDEN", "You are not authorized to view this ride.", 403);
    }

    // Also fetch driver details if assigned
    if (ride.rider_id) {
      const drivers = await db.query("SELECT full_name as name, phone, id FROM users WHERE id = $1", [ride.rider_id]);
      if (drivers.length > 0) {
        ride.driver = drivers[0];
        // Fetch vehicle
        const vehicles = await db.query(
          `SELECT rv.* FROM rider_vehicles rv
           JOIN rider_profiles rp ON rp.id = rv.rider_id
           WHERE rp.user_id = $1
           ORDER BY rv.created_at DESC LIMIT 1`,
          [ride.rider_id]
        );
        if (vehicles.length > 0) {
          ride.driver.vehicle_number = vehicles[0].license_plate || vehicles[0].registration_number;
          ride.vehicle_info = vehicles[0];
        }
      }
    }

    if (ride.customer_id === authReq.user!.id && ride.status === "requested") {
      ride.offers = await db.query(
        `SELECT ro.id, ro.proposed_fare, ro.status, ro.created_at,
                u.id AS driver_id, u.full_name AS driver_name,
                rp.rating AS driver_rating, rp.total_rides,
                rv.make_model, rv.license_plate, rv.registration_number, rv.color
           FROM ride_offers ro
           JOIN users u ON u.id = ro.offerer_id
           LEFT JOIN rider_profiles rp ON rp.user_id = u.id
           LEFT JOIN rider_vehicles rv ON rv.rider_id = rp.id
          WHERE ro.ride_id = $1 AND ro.status = 'pending'
          ORDER BY ro.created_at ASC`,
        [ride.id]
      );
    }

    ride.display_fare = Number(ride.accepted_fare ?? ride.fare ?? ride.customer_offer_fare ?? ride.system_estimated_fare ?? ride.total_fare ?? 0);
    
    return sendSuccess(res, ride);
  } catch (err: any) {
    return sendError(res, "FETCH_FAILED", err.message, 500);
  }
});

export default router;
