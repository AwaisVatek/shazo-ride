import { Response } from "express";

/**
 * Send standard success JSON structure
 */
export function sendSuccess(res: Response, data: any = {}, status = 200) {
  return res.status(status).json({
    ok: true,
    data
  });
}

/**
 * Send standard error JSON structure
 */
export function sendError(res: Response, code: string, message: string, status = 400) {
  return res.status(status).json({
    ok: false,
    error: {
      code,
      message
    }
  });
}
