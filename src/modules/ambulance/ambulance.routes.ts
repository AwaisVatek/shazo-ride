import { Router, Request, Response } from "express";
import crypto from "crypto";
import { requireAuth, requireOperationsManager, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { config } from "../../config/index";
import { db } from "../../db/index";
import { io } from "../../server";

const router = Router();

/**
 * POST /api/ambulance/estimate
 * Computes paid Ambulance Ride fares dynamically based on database service rules
 */
router.post("/estimate", requireAuth, async (req: Request, res: Response) => {
  const { pickup_lat, pickup_lng, destination_lat, destination_lng } = req.body;

  if (pickup_lat === undefined || pickup_lng === undefined) {
    return sendError(res, "VALIDATION_FAILED", "Please supply pickup coordinates.");
  }

  try {
    let distance_km = 8.0; // fallback standard pilot distance
    if (destination_lat !== undefined && destination_lng !== undefined) {
      const distResponse = await fetch(`${config.API_BASE_URL}/api/maps/distance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": req.headers.authorization!
        },
        body: JSON.stringify({ origin_lat: pickup_lat, origin_lng: pickup_lng, dest_lat: destination_lat, dest_lng: destination_lng })
      });
      if (distResponse.ok) {
        const distBody: any = await distResponse.json();
        if (distBody.ok) {
          distance_km = distBody.data.distance_km;
        }
      }
    }

    // Load active paid ambulance rate configuration parameters from PostgreSQL
    const srvRates = await db.query("SELECT * FROM service_settings WHERE service_type = 'ambulance'");
    if (srvRates.length === 0) {
      return sendError(res, "CONFIG_MISSING", "Ambulance service parameters are currently uninitialized.");
    }

    const ar = srvRates[0];
    
    // Ambulance pricing formula: base_fare + (distance * per_km_rate)
    let fareBase = Number(ar.base_fare) + (distance_km * Number(ar.per_km_rate));
    fareBase = Math.max(fareBase, Number(ar.minimum_fare));

    return sendSuccess(res, {
      service_type: "ambulance",
      service_name: "Emergency Ambulance Ride",
      premium_fare: Math.round(fareBase),
      currency: config.DEFAULT_CURRENCY,
      notice: "Ambulance Ride service is paid and subject to availability and coverage in Karachi.",
      details: "Includes trained physiological support crew on dispatch."
    });

  } catch (err: any) {
    return sendError(res, "ESTIMATE_AMBULANCE_FAILED", err.message, 500);
  }
});

/**
 * POST /api/ambulance/create
 * Books a paid Emergency Ambulance Ride routing incident
 */
router.post("/create", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { patient_name, contact_number, pickup_address, pickup_lat, pickup_lng, destination_hospital, emergency_type, notes } = req.body;

  if (!patient_name || !contact_number || !pickup_address || pickup_lat === undefined || pickup_lng === undefined || !destination_hospital || !emergency_type) {
    return sendError(res, "VALIDATION_FAILED", "Please provide patient info, contact details, coordinates, and destination hospital.");
  }

  try {
    // 1. Calculate fare dynamically
    let fare = 1500; // standard fallback
    const estResponse = await fetch(`${config.API_BASE_URL}/api/ambulance/estimate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": req.headers.authorization!
      },
      body: JSON.stringify({ pickup_lat, pickup_lng })
    });
    if (estResponse.ok) {
      const estBody: any = await estResponse.json();
      if (estBody.ok) fare = estBody.data.premium_fare;
    }

    // 2. Commit transaction to PostgreSQL
    const bookingId = "amb_" + crypto.randomUUID().slice(0, 8);
    await db.query(
      `INSERT INTO ambulance_bookings (id, customer_id, patient_name, contact_number, pickup_address, pickup_lat, pickup_lng, destination_hospital, emergency_type, notes, fare_estimate, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'requested')`,
      [bookingId, req.user!.id, patient_name, contact_number, pickup_address, pickup_lat, pickup_lng, destination_hospital, emergency_type, notes || "", fare]
    );

    const booking = await db.query("SELECT * FROM ambulance_bookings WHERE id = $1", [bookingId]);

    return sendSuccess(res, {
      booking: booking[0],
      notice: "Subject to availability and coverage. Ambulance dispatches are fully paid services."
    }, 201);

  } catch (err: any) {
    return sendError(res, "AMBULANCE_BOOKING_FAILED", err.message, 500);
  }
});

/**
 * PATCH /api/ambulance/:id/status
 * Updates dispatch state and assigns vehicle details
 */
router.patch("/:id/status", requireAuth, requireOperationsManager, async (req: Request, res: Response) => {
  const bookingId = req.params.id;
  const { status, driver_name, assigned_vehicle_number } = req.body;

  if (!status) return sendError(res, "VALIDATION_FAILED", "Status parameters are missing.");

  try {
    const updated = await db.query(
      `UPDATE ambulance_bookings
       SET status = $1,
           driver_name = COALESCE($2, driver_name),
           assigned_vehicle_number = COALESCE($3, assigned_vehicle_number),
           dispatched_at = CASE WHEN $1 = 'dispatched' THEN NOW() ELSE dispatched_at END,
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [status, driver_name || null, assigned_vehicle_number || null, bookingId]
    );

    if (updated.length === 0) {
      return sendError(res, "NOT_FOUND", "No ambulance dispatch record matches this ID.", 404);
    }

    io.to(`ambulance_${bookingId}`).emit("ambulance_update", { requestId: bookingId, status });
    return sendSuccess(res, { booking: updated[0] });

  } catch (err: any) {
    return sendError(res, "UPDATE_AMBULANCE_STATUS_FAILED", err.message, 500);
  }
});

export default router;
