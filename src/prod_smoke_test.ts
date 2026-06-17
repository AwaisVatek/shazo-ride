const API_URL = "https://app.shazoride.com/api";

async function runProdTests() {
  console.log("--- STARTING PRODUCTION SMOKE TEST ---");

  // 1. Customer Signup
  const custPhone = "+923" + Math.floor(Math.random() * 900000000 + 100000000);
  console.log(`\n[Customer] Signing up with phone: ${custPhone}`);
  const custSignupRes = await fetch(`${API_URL}/auth/signup-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      full_name: "Prod Customer",
      phone: custPhone,
      password: "Password123!",
      role: "customer"
    })
  });
  const custSignupData = await custSignupRes.json();
  if (!custSignupRes.ok) {
    console.error("Customer Signup Failed:", custSignupData);
    process.exit(1);
  }
  console.log("Customer Signup Success:", custSignupData);
  if (custSignupData.data?.user?.role !== "customer") {
    console.error("Customer role mismatch!", custSignupData.data?.user);
    process.exit(1);
  }

  // 2. Rider Signup
  const riderPhone = "+923" + Math.floor(Math.random() * 900000000 + 100000000);
  console.log(`\n[Rider] Signing up with phone: ${riderPhone}`);
  const riderSignupRes = await fetch(`${API_URL}/auth/signup-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      full_name: "Prod Rider",
      phone: riderPhone,
      password: "Password123!",
      role: "rider"
    })
  });
  const riderSignupData = await riderSignupRes.json();
  if (!riderSignupRes.ok) {
    console.error("Rider Signup Failed:", riderSignupData);
    process.exit(1);
  }
  console.log("Rider Signup Success:", riderSignupData);
  if (riderSignupData.data?.user?.role !== "rider") {
    console.error("Rider role mismatch!", riderSignupData.data?.user);
    process.exit(1);
  }
  
  const riderToken = riderSignupData.data?.token;

  // 3. Customer Login
  console.log(`\n[Customer] Logging in with ${custPhone}`);
  const custLoginRes = await fetch(`${API_URL}/auth/login-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: custPhone, password: "Password123!" })
  });
  const custLoginData = await custLoginRes.json();
  if (!custLoginRes.ok) {
    console.error("Customer Login Failed:", custLoginData);
    process.exit(1);
  }
  console.log("Customer Login Success:", custLoginData.data ? "Token received" : custLoginData);

  // 4. Rider Login
  console.log(`\n[Rider] Logging in with ${riderPhone}`);
  const riderLoginRes = await fetch(`${API_URL}/auth/login-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: riderPhone, password: "Password123!" })
  });
  const riderLoginData = await riderLoginRes.json();
  if (!riderLoginRes.ok) {
    console.error("Rider Login Failed:", riderLoginData);
    process.exit(1);
  }
  console.log("Rider Login Success:", riderLoginData.data ? "Token received" : riderLoginData);

  // 5. Rider token can POST /api/rider/vehicle
  console.log(`\n[Rider] POST /api/rider/vehicle`);
  const vehiclePostRes = await fetch(`${API_URL}/rider/vehicle`, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "Authorization": `Bearer ${riderToken}`
    },
    body: JSON.stringify({
      vehicle_make: "Honda",
      vehicle_model: "CG125",
      vehicle_year: 2022,
      vehicle_color: "Red",
      vehicle_plate_number: "ABC-1234"
    })
  });
  const vehiclePostData = await vehiclePostRes.json();
  if (!vehiclePostRes.ok) {
    console.error("Rider Vehicle POST Failed:", vehiclePostData);
    process.exit(1);
  }
  console.log("Rider Vehicle POST Success:", vehiclePostData);

  // 6. Rider token can GET /api/rider/vehicle
  console.log(`\n[Rider] GET /api/rider/vehicle`);
  const vehicleGetRes = await fetch(`${API_URL}/rider/vehicle`, {
    method: "GET",
    headers: { 
      "Content-Type": "application/json",
      "Authorization": `Bearer ${riderToken}`
    }
  });
  const vehicleGetData = await vehicleGetRes.json();
  if (!vehicleGetRes.ok) {
    console.error("Rider Vehicle GET Failed:", vehicleGetData);
    process.exit(1);
  }
  console.log("Rider Vehicle GET Success:", vehicleGetData);

  console.log("\n--- SMOKE TEST COMPLETED SUCCESSFULLY ---");
  console.log(`Please run Supabase queries to confirm rows exist for:`);
  console.log(`Customer Phone: ${custPhone}`);
  console.log(`Rider Phone: ${riderPhone}`);
}

runProdTests().catch(e => console.error("Test execution failed:", e));
