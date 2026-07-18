-- ride_bookings had no column for the customer's free-text review — POST
-- /api/rides/:id/rate was writing it into audit_logs.notes as an unstructured
-- string instead, so it could never be shown back to the customer on their
-- own ride receipt (RideReceiptScreen.tsx reads ride_bookings.rider_review,
-- which never existed). Real column now backs it directly.
ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS rider_review TEXT;
