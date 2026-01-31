"use strict";

const { JWT } = require("google-auth-library");
const { env } = require("../config/env");

let cached = { token: null, exp: 0 };

async function getVertexAccessToken() {
  const now = Date.now();
  if (cached.token && cached.exp - now > 60_000) return cached.token;

  const sa = JSON.parse(Buffer.from(env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, "base64").toString("utf8"));

  const client = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"]
  });

  const { access_token, expiry_date } = await client.authorize();
  cached = { token: access_token, exp: expiry_date || (now + 50 * 60_000) };
  return cached.token;
}

module.exports = { getVertexAccessToken };
