import { Router, Request, Response } from "express";
import crypto from "crypto";
import { db } from "../../db/index";
import { evolutionService } from "../../services/evolution-whatsapp.service";

const router = Router();

/**
 * GET /api/webhooks/evolution/health
 * Simple health check for the Evolution webhook receiver
 */
router.get("/evolution/health", (req: Request, res: Response) => {
  res.status(200).json({ ok: true, message: "Evolution webhook receiver is healthy" });
});

/**
 * POST /api/webhooks/evolution
 * Ingest Evolution WhatsApp events and log them safely
 */
router.post("/evolution", async (req: Request, res: Response) => {
  // Always return 200 quickly to acknowledge receipt
  res.status(200).send("OK");

  try {
    const payload = req.body;
    
    // Safety check - ignore empty payloads
    if (!payload || typeof payload !== 'object') return;

    // Evolution typically wraps the event name in "event" and the data in "data" or similar
    const eventType = payload.event || "UNKNOWN_EVENT";
    const instanceName = payload.instance || "unknown";
    
    // Attempt to extract remote sender and message ID safely without failing
    let remoteJid = null;
    let messageId = null;

    if (payload.data?.key) {
      remoteJid = payload.data.key.remoteJid;
      messageId = payload.data.key.id;
    } else if (payload.data?.message?.key) {
      remoteJid = payload.data.message.key.remoteJid;
      messageId = payload.data.message.key.id;
    }

    const logId = "wel_" + crypto.randomUUID().slice(0, 8);

    await db.query(
      `INSERT INTO whatsapp_event_logs (id, provider, instance_name, event_type, remote_jid, message_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [logId, 'evolution', instanceName, eventType, remoteJid, messageId, JSON.stringify(payload)]
    );

  } catch (error) {
    // Log internally but do not fail the webhook request
    console.error("❌ Failed to process Evolution webhook payload:", error);
  }
});

export default router;
