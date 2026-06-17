import { db } from './db/index';

const API_URL = 'http://localhost:3000'; // Assuming this is the port

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
  try {
    json = JSON.parse(text);
  } catch (e) {}

  if (!res.ok) {
    throw new Error(json?.error?.message || json?.message || json?.error || text || `HTTP ${res.status}`);
  }
  return { status: res.status, data: json };
}

async function runTests() {
  console.log('--- STARTING SHAZO SMOKE TEST ---');
  let customerToken = '';
  let riderToken = '';
  let customerId = '';
  let riderId = '';
  
  const customerPhone = '+923' + Math.floor(Math.random() * 900000000 + 100000000).toString();
  const riderPhone = '+923' + Math.floor(Math.random() * 900000000 + 100000000).toString();
  const password = 'Password123!';

  console.log('\n1. AUTHENTICATION & ROLE SEPARATION');
  
  try {
    console.log(`[Customer] Signing up with phone: ${customerPhone}`);
    let res = await apiFetch('/api/auth/signup-password', 'POST', { phone: customerPhone, username: `cust_${Math.floor(Math.random()*1000)}`, password, role: 'customer', full_name: 'Test Customer' });
    console.log(`[Customer Signup] Response:`, res.status, res.data?.message || 'OK');
    
    console.log(`[Rider] Signing up with phone: ${riderPhone}`);
    res = await apiFetch('/api/auth/signup-password', 'POST', { phone: riderPhone, username: `rider_${Math.floor(Math.random()*1000)}`, password, role: 'rider', full_name: 'Test Rider' });
    console.log(`[Rider Signup] Response:`, res.status, res.data?.message || 'OK');

    console.log(`[Customer] Logging in...`);
    res = await apiFetch('/api/auth/login-password', 'POST', { phone: customerPhone, password });
    customerToken = res.data?.token || res.data?.data?.token;
    customerId = res.data?.user?.id || res.data?.data?.user?.id;
    console.log(`[Customer Login] Token received.`);

    console.log(`[Rider] Logging in...`);
    res = await apiFetch('/api/auth/login-password', 'POST', { phone: riderPhone, password });
    riderToken = res.data?.token || res.data?.data?.token;
    riderId = res.data?.user?.id || res.data?.data?.user?.id;
    console.log(`[Rider Login] Token received.`);

    console.log('\n2. DB ROW VERIFICATION FOR RIDER');
    let userRow = await db.query('SELECT role FROM users WHERE id = $1', [riderId]);
    console.log(`[DB] users.role for rider:`, userRow[0]?.role);
    
    let profileRow = await db.query('SELECT verification_status FROM rider_profiles WHERE user_id = $1', [riderId]);
    console.log(`[DB] rider_profiles found:`, profileRow.length > 0);
    
    let walletRow = await db.query('SELECT balance FROM rider_wallets WHERE rider_id = $1', [riderId]);
    console.log(`[DB] rider_wallets found:`, walletRow.length > 0, walletRow[0]?.balance);

    console.log('\n3. VEHICLE APIS');
    console.log(`[Rider] Submitting vehicle...`);
    res = await apiFetch('/api/rider/vehicle', 'POST', {
      make_model: 'Honda CD 70',
      color: 'Red',
      license_plate: 'ABC-1234' + Math.random().toString().substring(2,5),
      year: '2022',
      vehicle_category: 'bike',
      registration_number: 'REG-123',
      ownership_status: 'owned',
      registration_document_url: 'base64_reg',
      vehicle_images: '["base64_v1"]'
    }, riderToken);
    console.log(`[POST Vehicle] Response:`, res.status);

    res = await apiFetch('/api/rider/vehicle', 'GET', undefined, riderToken);
    console.log(`[GET Vehicle] Returned Category:`, res.data?.data?.vehicle_category, `Make:`, res.data?.data?.make_model);

    console.log('\n4. DOCUMENT APIS');
    console.log(`[Rider] Submitting document...`);
    res = await apiFetch('/api/rider/documents', 'POST', {
      document_type: 'cnic_front',
      file_url: 'base64_cnic'
    }, riderToken);
    console.log(`[POST Doc] Response:`, res.status);
    
    res = await apiFetch('/api/rider/documents', 'GET', undefined, riderToken);
    console.log(`[GET Docs] Returned Docs:`, res.data?.data?.length);

    console.log('\n5. ADMIN APPROVAL');
    console.log(`[DB] Using DB query to simulate Admin approval/rejection of rider_vehicles and rider_documents`);
    
    let docRows = await db.query('SELECT id FROM rider_documents WHERE rider_id = $1', [riderId]);
    let docId = docRows[0]?.id;
    
    console.log(`[Admin DB] Setting doc status to rejected with reason...`);
    await db.query('UPDATE rider_documents SET status = $1, rejection_reason = $2 WHERE id = $3 AND rider_id = $4', ['rejected', 'Blurry CNIC', docId, riderId]);
    let checkDoc = await db.query('SELECT status, rejection_reason FROM rider_documents WHERE id = $1', [docId]);
    console.log(`[DB Doc] Status: ${checkDoc[0]?.status}, Reason: ${checkDoc[0]?.rejection_reason}`);

    await db.query('UPDATE rider_profiles SET verification_status = $1, rejection_reason = $2 WHERE user_id = $3', ['rejected', 'Profile incomplete', riderId]);
    res = await apiFetch('/api/auth/profile', 'GET', undefined, riderToken);
    console.log(`[Rider Profile] verification_status: ${res.data?.data?.verification_status}, rejection_reason: ${res.data?.data?.rejection_reason}`);

    console.log('\n6. CUSTOMER BOOKING');
    console.log(`[Customer] Requesting ride types...`);
    res = await apiFetch('/api/rides/types', 'GET', undefined, customerToken);
    console.log(`[Customer Ride Types] Available:`, res.data?.data?.types?.map((t: any) => t.category));

    console.log(`[Customer] Booking ride...`);
    res = await apiFetch('/api/rides/book', 'POST', {
      pickup_address: 'Start',
      pickup_lat: 24.86,
      pickup_lng: 67.0,
      dropoff_address: 'End',
      dropoff_lat: 24.87,
      dropoff_lng: 67.01,
      service_type: 'bike',
      vehicle_category: 'bike',
      customer_offer_fare: 150.00,
      system_estimated_fare: 180.00,
      payment_method: 'cash'
    }, customerToken);
    
    console.log(`[Customer Book] Response:`, res.status, res.data?.message || 'OK');
    let bookingId = res.data?.data?.id || res.data?.id || res.data?.data?.booking?.id;
    
    if (bookingId) {
      let bookingRow = await db.query('SELECT vehicle_category, customer_offer_fare, system_estimated_fare, negotiation_status FROM ride_bookings WHERE id = $1', [bookingId]);
      console.log(`[DB Booking] Values:`, bookingRow[0]);
    } else {
      console.log(`[DB Booking] Could not find booking ID in response:`, Object.keys(res.data?.data || {}));
      
      let latestBooking = await db.query('SELECT vehicle_category, customer_offer_fare, system_estimated_fare, negotiation_status FROM ride_bookings WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1', [customerId]);
      console.log(`[DB Booking fallback] Latest for customer:`, latestBooking[0]);
    }

    console.log('\n--- TESTS COMPLETED SUCCESSFULLY ---');
    process.exit(0);
  } catch (err: any) {
    console.error('Test Failed:', err?.message || err);
    console.error('Stack:', err?.stack);
    process.exit(1);
  }
}

runTests();
