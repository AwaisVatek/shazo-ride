-- ride_offers and ride_bookings.minimum_fare/promo_code_used are already
-- referenced by working code (POST /api/rides/offer-fare's INSERT, POST
-- /api/rides/request's fare validation, and the customer app's multi-offer
-- negotiation UI) and were already described in migrations 0001/0007 — but
-- confirmed via information_schema against this production database that
-- neither the table nor the columns were ever actually deployed here.
CREATE TABLE IF NOT EXISTS ride_offers (
  id VARCHAR(80) PRIMARY KEY,
  ride_id VARCHAR(80) NOT NULL REFERENCES ride_bookings(id) ON DELETE CASCADE,
  by_role VARCHAR(50) NOT NULL, -- rider, customer
  offerer_id VARCHAR(80) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposed_fare NUMERIC(10,2) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, accepted, counter_offered, rejected
  is_counter_offer BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS minimum_fare NUMERIC(10,2) DEFAULT 0;
ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS promo_code_used VARCHAR(50);
