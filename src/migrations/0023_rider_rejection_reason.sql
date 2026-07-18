-- admin.routes.ts's PATCH /riders/:id has always written rejection_reason
-- to rider_profiles, but the column never existed — the whole UPDATE
-- (including verification_status) silently failed every time via
-- safeRows()'s swallowed-error pattern, while the endpoint unconditionally
-- returned "Rider updated." success regardless. No admin has ever been
-- able to approve or reject a rider through this endpoint.
ALTER TABLE rider_profiles ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
