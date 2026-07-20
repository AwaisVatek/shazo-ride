import { db } from '../../db/index';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { io: ioClient } = require('C:/Users/muhammad.awais_codup/Documents/Awais/shazo-ride/shazo-ride/shazo-rider-app/node_modules/socket.io-client');

const API_URL = 'http://localhost:3000';

async function apiFetch(endpoint: string, method: string, data?: any, token?: string) {
  const headers: any = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${endpoint}`, { method, headers, body: data ? JSON.stringify(data) : undefined });
  let json = null;
  try { json = JSON.parse(await res.text()); } catch (e) {}
  return { status: res.status, ok: res.ok, data: json };
}

function waitFor(socket: any, event: string, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (arg: any) => { clearTimeout(t); resolve(arg); });
  });
}

async function run() {
  console.log('--- SOCKET AUTH / GHOST-RIDER / RIDE-ROOM-OWNERSHIP TEST ---');
  let riderAId = '', riderBId = '', customerId = '', rideId = '';
  let riderAToken = '', riderBToken = '', customerToken = '';

  try {
    const phoneA = '+923' + Math.floor(Math.random() * 900000000 + 100000000);
    const phoneB = '+923' + Math.floor(Math.random() * 900000000 + 100000000);
    const phoneC = '+923' + Math.floor(Math.random() * 900000000 + 100000000);
    const pass = 'Password123!';

    await apiFetch('/api/auth/signup-password', 'POST', { phone: phoneA, username: 'e2e_sockA_' + Date.now(), password: pass, role: 'rider', full_name: 'Socket Rider A' });
    await apiFetch('/api/auth/signup-password', 'POST', { phone: phoneB, username: 'e2e_sockB_' + Date.now(), password: pass, role: 'rider', full_name: 'Socket Rider B' });
    await apiFetch('/api/auth/signup-password', 'POST', { phone: phoneC, username: 'e2e_sockC_' + Date.now(), password: pass, role: 'customer', full_name: 'Socket Customer' });

    let res = await apiFetch('/api/auth/login-password', 'POST', { phone: phoneA, password: pass });
    riderAToken = res.data.data?.token || res.data.token; riderAId = res.data.data?.user?.id || res.data.user?.id;
    res = await apiFetch('/api/auth/login-password', 'POST', { phone: phoneB, password: pass });
    riderBToken = res.data.data?.token || res.data.token; riderBId = res.data.data?.user?.id || res.data.user?.id;
    res = await apiFetch('/api/auth/login-password', 'POST', { phone: phoneC, password: pass });
    customerToken = res.data.data?.token || res.data.token; customerId = res.data.data?.user?.id || res.data.user?.id;
    console.log('[users]', { riderAId, riderBId, customerId });

    console.log('\n[1] Connect with NO token — must be rejected');
    const noAuthSocket = ioClient(API_URL, { autoConnect: false });
    noAuthSocket.connect();
    const noAuthResult = await Promise.race([
      waitFor(noAuthSocket, 'connect').then(() => 'connected'),
      waitFor(noAuthSocket, 'connect_error').then(() => 'rejected'),
    ]);
    console.log('no-token connection result:', noAuthResult);
    if (noAuthResult !== 'rejected') throw new Error('Unauthenticated socket connection was NOT rejected');
    noAuthSocket.close();

    console.log('\n[2] Connect with a valid rider token — must succeed');
    const riderASocket = ioClient(API_URL, { autoConnect: false, auth: { token: riderAToken } });
    riderASocket.connect();
    await waitFor(riderASocket, 'connect');
    console.log('rider A connected:', riderASocket.connected);

    console.log('\n[3] Set rider A online in DB, then disconnect the socket — confirm ghost-rider cleanup fires');
    await db.query("UPDATE rider_profiles SET is_online = true WHERE user_id = $1", [riderAId]);
    let before = await db.query('SELECT is_online FROM rider_profiles WHERE user_id = $1', [riderAId]);
    console.log('is_online before disconnect:', before[0].is_online);
    riderASocket.close();
    await new Promise((r) => setTimeout(r, 1000)); // let the server's disconnect handler run
    let after = await db.query('SELECT is_online FROM rider_profiles WHERE user_id = $1', [riderAId]);
    console.log('is_online after disconnect:', after[0].is_online);
    if (after[0].is_online !== false) throw new Error('Ghost-rider cleanup did not fire on disconnect');

    console.log('\n[4] Ride-room ownership: create a real ride between customer and rider B, confirm rider A (uninvolved) cannot receive its events');
    res = await apiFetch('/api/rides/request', 'POST', {
      pickup_address: 'Socket Test Pickup', pickup_lat: 24.86, pickup_lng: 67.0,
      dropoff_address: 'Socket Test Dropoff', dropoff_lat: 24.88, dropoff_lng: 67.02,
      vehicle_category: 'bike', payment_method: 'cash', customer_offer_fare: 300
    }, customerToken);
    rideId = res.data?.data?.ride?.id;
    console.log('created ride', rideId, 'status', res.status);
    if (!rideId) throw new Error('could not create test ride: ' + JSON.stringify(res.data));

    // Assign rider B directly in DB (skip full negotiation flow — not the focus of this test)
    await db.query("UPDATE ride_bookings SET rider_id = $1, status = 'accepted' WHERE id = $2", [riderBId, rideId]);

    const riderBSocket = ioClient(API_URL, { autoConnect: false, auth: { token: riderBToken } });
    const uninvolvedSocket = ioClient(API_URL, { autoConnect: false, auth: { token: riderAToken } }); // reuse rider A as an uninvolved 3rd party
    riderBSocket.connect();
    uninvolvedSocket.connect();
    await waitFor(riderBSocket, 'connect');
    await waitFor(uninvolvedSocket, 'connect');

    riderBSocket.emit('join_ride', rideId);
    uninvolvedSocket.emit('join_ride', rideId);
    await new Promise((r) => setTimeout(r, 500)); // let join_ride process server-side

    let involvedReceived = false, uninvolvedReceived = false;
    riderBSocket.on('receive_message', () => { involvedReceived = true; });
    uninvolvedSocket.on('receive_message', () => { uninvolvedReceived = true; });

    // Customer sends a chat message into the ride room
    const custSocket = ioClient(API_URL, { autoConnect: false, auth: { token: customerToken } });
    custSocket.connect();
    await waitFor(custSocket, 'connect');
    custSocket.emit('join_ride', rideId);
    await new Promise((r) => setTimeout(r, 300));
    custSocket.emit('send_message', { rideId, content: 'hello from customer' });
    await new Promise((r) => setTimeout(r, 800));

    console.log('involved rider (B) received the message:', involvedReceived);
    console.log('uninvolved rider (A) received the message (should be false):', uninvolvedReceived);
    if (!involvedReceived) throw new Error('The actually-assigned rider did not receive the chat message');
    if (uninvolvedReceived) throw new Error('SECURITY BUG: an uninvolved rider received a ride chat message they should never have seen');

    riderBSocket.close(); uninvolvedSocket.close(); custSocket.close();

    console.log('\n--- ALL ASSERTIONS PASSED ---');
  } finally {
    console.log('\n--- CLEANUP ---');
    if (rideId) {
      await db.query('DELETE FROM ride_messages WHERE ride_id = $1', [rideId]).catch(() => {});
      await db.query('DELETE FROM ride_status_logs WHERE ride_id = $1', [rideId]).catch(() => {});
      await db.query('DELETE FROM ride_bookings WHERE id = $1', [rideId]).catch(() => {});
    }
    for (const id of [riderAId, riderBId]) {
      if (!id) continue;
      const p = await db.query('SELECT id FROM rider_profiles WHERE user_id = $1', [id]);
      if (p.length > 0) await db.query('DELETE FROM rider_wallets WHERE rider_id = $1', [p[0].id]).catch(() => {});
      await db.query('DELETE FROM rider_profiles WHERE user_id = $1', [id]).catch(() => {});
      await db.query('DELETE FROM sessions WHERE user_id = $1', [id]).catch(() => {});
      await db.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
    }
    if (customerId) {
      await db.query('DELETE FROM sessions WHERE user_id = $1', [customerId]).catch(() => {});
      await db.query('DELETE FROM users WHERE id = $1', [customerId]).catch(() => {});
    }
    console.log('cleaned up.');
    process.exit(0);
  }
}

run().catch((e) => {
  console.error('TEST FAILED:', e.message);
  process.exit(1);
});
