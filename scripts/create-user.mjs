#!/usr/bin/env node
// Local-only admin tool - creates or resets a Supabase Auth user by email.
// Never routed in worker.js: account creation stays entirely off the
// deployed Worker's surface, gated only by possessing SUPABASE_SERVICE_ROLE_KEY.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/create-user.mjs <email> <password>
//
// If the email already has an account, this resets its password instead of
// failing - useful for account recovery without building a "forgot
// password" email flow (this app has no outbound email configured).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const [, , email, password] = process.argv;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!email || !password) {
  console.error("Usage: node scripts/create-user.mjs <email> <password>");
  process.exit(1);
}
if (password.length < 12) {
  console.error("Password must be at least 12 characters.");
  process.exit(1);
}

const authHeaders = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: "Bearer " + SERVICE_ROLE_KEY,
  "Content-Type": "application/json",
};

async function findUserByEmail(email) {
  const res = await fetch(
    SUPABASE_URL + "/auth/v1/admin/users?email=" + encodeURIComponent(email),
    { headers: authHeaders }
  );
  if (!res.ok) throw new Error("Lookup failed (" + res.status + "): " + (await res.text()));
  const data = await res.json();
  const users = data.users || data;
  return (Array.isArray(users) ? users : []).find((u) => u.email === email) || null;
}

async function main() {
  const existing = await findUserByEmail(email);

  if (existing) {
    const res = await fetch(SUPABASE_URL + "/auth/v1/admin/users/" + existing.id, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ password }),
    });
    if (!res.ok) throw new Error("Password reset failed (" + res.status + "): " + (await res.text()));
    console.log("Password reset for existing user " + email + " (id " + existing.id + ")");
    return;
  }

  const res = await fetch(SUPABASE_URL + "/auth/v1/admin/users", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!res.ok) throw new Error("User creation failed (" + res.status + "): " + (await res.text()));
  const user = await res.json();
  console.log("Created user " + email + " (id " + user.id + ")");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
