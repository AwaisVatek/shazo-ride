-- Log table for admin dashboard "System Notifications" broadcasts. Previously
-- POST /api/admin/notifications wrote a single `notifications` row scoped to
-- the admin's own user_id, so no customer/rider ever actually received it and
-- the dashboard had no real target_audience/created_at field to display. This
-- table is the broadcast-level audit log; per-user delivery still happens via
-- one `notifications` row per matching user (fanned out at request time).
CREATE TABLE IF NOT EXISTS admin_broadcasts (
  id VARCHAR(80) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  target_audience VARCHAR(20) NOT NULL DEFAULT 'all',
  sent_by VARCHAR(80) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_broadcasts_created_at ON admin_broadcasts(created_at);
