import { Router, Response } from "express";
import { requireAuth, AuthenticatedRequest } from "../../middleware/auth";
import { sendSuccess, sendError } from "../../utils/response";
import { db } from "../../db/index";

const router = Router();

router.use(requireAuth);

/**
 * GET /api/notifications
 * Lists history of sent indicators for the logged consumer
 */
router.get("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const list = await db.query(
      "SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
      [req.user!.id]
    );
    return sendSuccess(res, { notifications: list });
  } catch (err: any) {
    return sendError(res, "FETCH_NOTIFICATIONS_FAILED", err.message, 500);
  }
});

/**
 * POST /api/notifications/:id/read
 * Marks a notification as read
 */
router.post("/:id/read", async (req: AuthenticatedRequest, res: Response) => {
  const noteId = req.params.id;

  try {
    await db.query(
      "UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2",
      [noteId, req.user!.id]
    );
    return sendSuccess(res, { message: "Notification marked read." });
  } catch (err: any) {
    return sendError(res, "MARK_READ_FAILED", err.message, 500);
  }
});

export default router;
