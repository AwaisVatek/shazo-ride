import { evolutionService } from "./evolution-whatsapp.service";
import { sendEmail, sendSMS } from "../utils/notify"; // fallback to existing for email/sms
import { config } from "../config/index";
import { db } from "../db/index";

export type NotificationEvent =
  | "otp"
  | "ride_booked"
  | "rider_assigned"
  | "rider_arrived"
  | "ride_started"
  | "ride_completed"
  | "food_order_placed"
  | "food_picked_up"
  | "food_delivered"
  | "wallet_topup_approved"
  | "wallet_topup_rejected"
  | "ambulance_request_received"
  | "ambulance_dispatched";

export class NotificationService {
  /**
   * Dispatch a notification using the configured primary channel (WhatsApp via Evolution)
   * Logs attempt to whatsapp_outbound_logs
   */
  public async dispatch(
    phone: string,
    event: NotificationEvent,
    payload: Record<string, any>
  ): Promise<boolean> {
    const message = this.buildMessage(event, payload);

    if (config.OTP_PROVIDER === "whatsapp_evolution" || config.WHATSAPP_PROVIDER === "evolution") {
      let logId: string | number = 0;
      
      try {
        // Log Pending
        const logRes = await db.query(
          `INSERT INTO whatsapp_outbound_logs 
           (provider, instance_name, phone, normalized_phone, message_type, status, request_payload) 
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          ["evolution", config.EVOLUTION_INSTANCE_NAME, phone, phone, event, "pending", JSON.stringify({ message: event === "otp" ? "OTP ***" : message })]
        );
        logId = logRes[0]?.id;

        const response = await evolutionService.sendTextMessage(phone, message);
        
        // Log Success
        if (logId) {
          await db.query(
            `UPDATE whatsapp_outbound_logs SET status = 'sent', response_payload = $1 WHERE id = $2`,
            [JSON.stringify(response), logId]
          );
        }
        return true;
      } catch (err: any) {
        console.error(`Failed to dispatch ${event} via Evolution API.`, err.message);
        
        // Log Failure
        if (logId) {
          await db.query(
            `UPDATE whatsapp_outbound_logs SET status = 'failed', error_message = $1 WHERE id = $2`,
            [err.message, logId]
          );
        }
        
        return false;
      }
    }

    // Fallbacks
    return false;
  }

  /**
   * Build the localized message template based on the event type
   */
  private buildMessage(event: NotificationEvent, payload: Record<string, any>): string {
    switch (event) {
      case "otp":
        return `Your Shazo Ride verification code is *${payload.otp}*.\n\nThis code will expire in ${config.OTP_EXPIRY_MINUTES} minutes. Do not share it with anyone.\n\nAap ka Shazo Ride verification code *${payload.otp}* hai.\n\nYeh code ${config.OTP_EXPIRY_MINUTES} minutes mein expire ho jayega. Isay kisi ke sath share na karein.`;

      case "ride_booked":
        return `🚗 Your Shazo Ride has been booked successfully! We are looking for a rider nearby.\n\nRide ID: ${payload.rideId}`;

      case "rider_assigned":
        return `✅ A rider has been assigned!\n\nRider: ${payload.riderName}\nVehicle: ${payload.vehicleInfo}\nETA: ${payload.eta || "Few mins"}`;

      case "rider_arrived":
        return `📍 Your rider has arrived at the pickup location. Please meet them outside.`;

      case "ride_started":
        return `🛣️ Your ride has started. Have a safe journey!`;

      case "ride_completed":
        return `🏁 Your ride has completed.\n\nTotal Fare: ${payload.currency || 'PKR'} ${payload.fare}\nThank you for choosing Shazo!`;

      case "wallet_topup_approved":
        return `💰 Your wallet top-up request for ${payload.currency || 'PKR'} ${payload.amount} has been APPROVED.\n\nNew Balance: ${payload.currency || 'PKR'} ${payload.newBalance}`;

      case "wallet_topup_rejected":
        return `❌ Your wallet top-up request for ${payload.currency || 'PKR'} ${payload.amount} was REJECTED. Please contact support.`;

      case "ambulance_request_received":
        return `🚑 Shazo Free Ambulance request received. We are dispatching the nearest ambulance to your location immediately.`;

      case "ambulance_dispatched":
        return `🚑 An ambulance is on the way to your location.\n\nDriver: ${payload.driverName}\nPhone: ${payload.driverPhone}`;

      case "food_order_placed":
        return `🍔 Your food order from ${payload.restaurantName} has been received and is being prepared!`;

      case "food_picked_up":
        return `🛵 Your food has been picked up by the rider and is on the way!`;

      case "food_delivered":
        return `🍽️ Your food has been delivered. Enjoy your meal!`;

      default:
        return `Notification from Shazo Ride: ${JSON.stringify(payload)}`;
    }
  }
}

export const domainNotifier = new NotificationService();
