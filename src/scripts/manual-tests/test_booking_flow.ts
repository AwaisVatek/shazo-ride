import { db } from './db/index';

const API_URL = 'http://localhost:3000';

async function apiFetch(endpoint: string, method: string, data?: any, token?: string) {
  const headers: any = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${endpoint}`, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined
  });

  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch (e) {}

  return { status: res.status, ok: res.ok, data: json };
}

async function run() {
  console.log('--- BOOKING/NEGOTIATION E2E TEST ---');
  const customerPhone = '+923' + Math.floor(Math.random() * 900000000 + 100000000).toString();
  const riderPhone = '+923' + Math.floor(Math.random() * 900000000 + 100000000).toString();
  const password = 'Password123!';
  let customerId = '', riderId = '', customerToken = '', riderToken = '', rideId = '';

  try {
    let res = await apiFetch('/api/auth/signup-password', 'POST', { phone: customerPhone, username: `e2e_cust_${Date.now()}`, password, role: 'customer', full_name: 'E2E Customer' });
    console.log('[Customer Signup]', res.status);

    res = await apiFetch('/api/auth/signup-password', 'POST', { phone: riderPhone, username: `e2e_rider_${Date.now()}`, password, role: 'rider', full_name: 'E2E Rider' });
    console.log('[Rider Signup]', res.status);

    res = await apiFetch('/api/auth/login-password', 'POST', { phone: customerPhone, password });
    customerToken = res.data?.data?.token || res.data?.token;
    customerId = res.data?.data?.user?.id || res.data?.user?.id;

    res = await apiFetch('/api/auth/login-password', 'POST', { phone: riderPhone, password });
    riderToken = res.data?.data?.token || res.data?.token;
    riderId = res.data?.data?.user?.id || res.data?.user?.id;
    console.log('[Logins]', customerId, riderId);

    // Rider needs a rider_profiles row to receive a rating lookup during offer-fare.
    const riderProfileCheck = await db.query('SELECT id FROM rider_profiles WHERE user_id = $1', [riderId]);
    console.log('[Rider profile auto-created on signup]', riderProfileCheck.length > 0);

    console.log('\n[1] GET /api/rides/types');
    res = await apiFetch('/api/rides/types', 'GET', undefined, customerToken);
    const types = res.data?.data?.types || [];
    console.log('service_types:', types.map((t: any) => `${t.service_type}(seats=${t.seats},name=${t.display_name})`));
    if (!types.find((t: any) => t.service_type === 'rickshaw')) throw new Error('rickshaw missing from /types response');

    console.log('\n[2] POST /api/rides/estimate');
    res = await apiFetch('/api/rides/estimate', 'POST', {
      pickup_lat: 24.86, pickup_lng: 67.00, dropoff_lat: 24.88, dropoff_lng: 67.02
    }, customerToken);
    console.log('estimate ok:', res.ok, JSON.stringify(res.data?.data?.estimates?.map((e: any) => ({ t: e.service_type, min: e.minimum_fare, rec: e.recommended_fare }))));

    console.log('\n[3] POST /api/rides/request (the previously-broken booking endpoint)');
    res = await apiFetch('/api/rides/request', 'POST', {
      pickup_address: 'E2E Pickup', pickup_lat: 24.86, pickup_lng: 67.00,
      dropoff_address: 'E2E Dropoff', dropoff_lat: 24.88, dropoff_lng: 67.02,
      vehicle_category: 'rickshaw', payment_method: 'cash', customer_offer_fare: 400
    }, customerToken);
    console.log('request status:', res.status, 'ok:', res.ok, res.data?.error?.message || res.data?.message);
    rideId = res.data?.data?.ride?.id;
    if (!rideId) throw new Error('Booking failed: ' + JSON.stringify(res.data));
    console.log('rideId:', rideId);

    const bookingRow = await db.query(
      'SELECT service_type, vehicle_category, fare, system_estimated_fare, customer_offer_fare, minimum_fare, negotiation_status, status FROM ride_bookings WHERE id = $1',
      [rideId]
    );
    console.log('[DB] booking row:', JSON.stringify(bookingRow[0]));
    if (bookingRow[0].vehicle_category !== 'rickshaw') throw new Error('vehicle_category mismatch');
    if (bookingRow[0].customer_offer_fare == null) throw new Error('customer_offer_fare not persisted');
    if (bookingRow[0].system_estimated_fare == null) throw new Error('system_estimated_fare not persisted (estimate self-fetch still broken)');
    if (bookingRow[0].minimum_fare == null) throw new Error('minimum_fare not persisted');

    console.log('\n[4] POST /api/rides/offer-fare (rider counter-offers)');
    res = await apiFetch('/api/rides/offer-fare', 'POST', { ride_id: rideId, proposed_fare: 420 }, riderToken);
    console.log('offer-fare status:', res.status, res.data?.error?.message || res.data?.message);
    const offerId = res.data?.data?.offerId;
    if (!offerId) throw new Error('offer-fare failed: ' + JSON.stringify(res.data));

    const offerRow = await db.query('SELECT * FROM ride_offers WHERE id = $1', [offerId]);
    console.log('[DB] ride_offers row:', JSON.stringify(offerRow[0]));

    const negotiationRow = await db.query('SELECT rider_counter_fare, negotiation_status FROM ride_bookings WHERE id = $1', [rideId]);
    console.log('[DB] ride_bookings negotiation state:', JSON.stringify(negotiationRow[0]));

    console.log('\n[5] POST /api/rides/:id/accept-offer (customer accepts the counter)');
    res = await apiFetch(`/api/rides/${rideId}/accept-offer`, 'POST', { offer_id: offerId }, customerToken);
    console.log('accept-offer status:', res.status, res.data?.error?.message || res.data?.message);
    if (!res.ok) throw new Error('accept-offer failed: ' + JSON.stringify(res.data));

    const finalRow = await db.query('SELECT status, rider_id, accepted_fare, fare, negotiation_status FROM ride_bookings WHERE id = $1', [rideId]);
    console.log('[DB] final booking state:', JSON.stringify(finalRow[0]));
    if (finalRow[0].status !== 'accepted') throw new Error('ride not accepted');
    if (finalRow[0].rider_id !== riderId) throw new Error('rider_id not assigned correctly');
    if (Number(finalRow[0].accepted_fare) !== 420) throw new Error('accepted_fare mismatch');

    console.log('\n--- ALL ASSERTIONS PASSED ---');
  } finally {
    console.log('\n--- CLEANUP ---');
    if (rideId) {
      await db.query('DELETE FROM ride_offers WHERE ride_id = $1', [rideId]);
      await db.query('DELETE FROM ride_status_logs WHERE ride_id = $1', [rideId]);
      await db.query('DELETE FROM ride_bookings WHERE id = $1', [rideId]);
    }
    if (riderId) {
      await db.query('DELETE FROM rider_wallets WHERE rider_id = (SELECT id FROM rider_profiles WHERE user_id = $1)', [riderId]);
      await db.query('DELETE FROM rider_profiles WHERE user_id = $1', [riderId]);
      await db.query('DELETE FROM users WHERE id = $1', [riderId]);
    }
    if (customerId) {
      await db.query('DELETE FROM customer_wallets WHERE customer_id = $1', [customerId]).catch(() => {});
      await db.query('DELETE FROM users WHERE id = $1', [customerId]);
    }
    console.log('Cleaned up test rows.');
    process.exit(0);
  }
}

run().catch((e) => {
  console.error('TEST FAILED:', e.message);
  process.exit(1);
});
