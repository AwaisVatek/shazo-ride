import { Router, Request, Response } from "express";
import crypto from "crypto";
import { requireAuth, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { db } from "../../db/index";

const router = Router();

router.use(requireAuth);

/**
 * GET /api/support/tickets
 * Lists support complaints tickets linked to the user
 */
router.get("/tickets", async (req: AuthenticatedRequest, res: Response) => {
  try {
    let query = "SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC";
    let params = [req.user!.id];

    if (req.user!.role === "admin" || req.user!.role === "support_agent") {
      query = "SELECT s.*, u.full_name as user_name FROM support_tickets s JOIN users u ON s.user_id = u.id ORDER BY s.created_at DESC";
      params = [];
    }

    const list = await db.query(query, params);
    return sendSuccess(res, { tickets: list });
  } catch (err: any) {
    return sendError(res, "FETCH_TICKETS_FAILED", err.message, 500);
  }
});

/**
 * POST /api/support/tickets
 * Opens a new issues ticket filing
 */
router.post("/tickets", async (req: AuthenticatedRequest, res: Response) => {
  const { category, subject, description, priority } = req.body;

  if (!category || !subject || !description) {
    return sendError(res, "VALIDATION_FAILED", "Please provide a category, subject and description.");
  }

  try {
    const ticketId = "tkt_" + crypto.randomUUID().slice(0, 8);
    const sourceCode = req.user!.role.toUpperCase().slice(0, 4);

    await db.query(
      `INSERT INTO support_tickets (id, user_id, source_type, category, subject, description, priority, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')`,
      [ticketId, req.user!.id, sourceCode, category, subject, description, priority || "medium"]
    );

    // Initial message creation
    const msgId = "msg_" + crypto.randomUUID().slice(0, 8);
    await db.query(
      `INSERT INTO ticket_messages (id, ticket_id, sender_id, message)
       VALUES ($1, $2, $3, $4)`,
      [msgId, ticketId, req.user!.id, description]
    );

    const ticket = await db.query("SELECT * FROM support_tickets WHERE id = $1", [ticketId]);

    return sendSuccess(res, { ticket: ticket[0] }, 201);

  } catch (err: any) {
    return sendError(res, "SUBMIT_TICKET_FAILED", err.message, 500);
  }
});

/**
 * GET /api/support/tickets/:id/messages
 * Retrieves messaging logs linked to matched incident folders
 */
router.get("/tickets/:id/messages", async (req: Request, res: Response) => {
  const ticketId = req.params.id;

  try {
    const messages = await db.query(
      `SELECT tm.*, u.full_name as sender_name, u.role as sender_role 
       FROM ticket_messages tm
       JOIN users u ON tm.sender_id = u.id
       WHERE tm.ticket_id = $1 
       ORDER BY tm.created_at ASC`,
      [ticketId]
    );

    return sendSuccess(res, { messages });
  } catch (err: any) {
    return sendError(res, "FETCH_MESSAGES_FAILED", err.message, 500);
  }
});

/**
 * POST /api/support/tickets/:id/messages
 * Appends response notes to the incident conversation trail
 */
router.post("/tickets/:id/messages", async (req: AuthenticatedRequest, res: Response) => {
  const ticketId = req.params.id;
  const { message } = req.body;

  if (!message) return sendError(res, "VALIDATION_FAILED", "A message note is mandatory.");

  try {
    const tickets = await db.query("SELECT id, status FROM support_tickets WHERE id = $1", [ticketId]);
    if (tickets.length === 0) return sendError(res, "TICKET_NOT_FOUND", "Incident ticket missing.", 404);

    const msgId = "msg_" + crypto.randomUUID().slice(0, 8);
    await db.query(
      `INSERT INTO ticket_messages (id, ticket_id, sender_id, message)
       VALUES ($1, $2, $3, $4)`,
      [msgId, ticketId, req.user!.id, message]
    );

    // If responder is pilot/support, flip status tags
    const isAgent = req.user!.role === "admin" || req.user!.role === "support_agent";
    const nextStatus = isAgent ? "waiting_user" : "open";
    
    await db.query(
      "UPDATE support_tickets SET status = $1, updated_at = NOW() WHERE id = $2",
      [nextStatus, ticketId]
    );

    return sendSuccess(res, {
      messageId: msgId,
      status: nextStatus
    }, 201);

  } catch (err: any) {
    return sendError(res, "POST_RESPONSE_FAILED", err.message, 500);
  }
});

export default router;
