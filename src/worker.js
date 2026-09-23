// Thin same-origin proxy to Supabase's PostgREST API: the frontend calls
// /api/db/<table>?<postgrest-query>, this injects the Supabase apikey/
// Authorization headers server-side (never shipped to the client) and
// forwards to <SUPABASE_URL>/rest/v1/<table>?<...>. Keeps the anon key out
// of public/index.html entirely. The Authorization header carries the
// caller's own Supabase Auth access token (not the anon key) so PostgREST's
// row-level security policies resolve auth.uid() to the right user.
async function handleDbProxy(request, url, env, session) {
  const restPath = url.pathname.slice("/api/db/".length);
  const target = env.SUPABASE_URL + "/rest/v1/" + restPath + url.search;
  const headers = new Headers();
  headers.set("apikey", env.SUPABASE_ANON_KEY);
  headers.set("Authorization", "Bearer " + session.accessToken);
  headers.set("Content-Type", "application/json");
  const prefer = request.headers.get("Prefer");
  if (prefer) headers.set("Prefer", prefer);

  const init = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.text();
  }
  const resp = await fetch(target, init);
  return new Response(resp.body, resp);
}

// Same-origin proxy to Supabase Storage for the "before" photos on the Info
// tab and the company logo. Always uses the service-role key (bucket writes
// aren't allowed for the anon key) and streams bytes through the Worker -
// the project-images bucket is private, so this proxy is the only path to
// the bytes. Ownership is checked here rather than relying on bucket-level
// policies: a "_settings/..." path is the shared company logo (any
// authenticated user), anything else is "<projectId>/...", and the caller
// must own that project - checked by re-running the lookup through
// handleDbProxy's own RLS-protected path, so this reuses the same source of
// truth as the projects table itself instead of duplicating the rule.
async function authorizeStoragePath(objectPath, session, env) {
  const firstSeg = objectPath.split("/")[0];
  if (firstSeg === "_settings") return null;
  const check = await fetch(
    env.SUPABASE_URL + "/rest/v1/projects?id=eq." + encodeURIComponent(firstSeg) + "&select=id",
    {
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: "Bearer " + session.accessToken,
      },
    }
  );
  const rows = check.ok ? await check.json() : [];
  if (!rows.length) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

async function handleStorageProxy(request, url, env, session) {
  const restPath = url.pathname.slice("/api/storage/".length);
  // Supabase's own path shape is object/<bucket>/<path-in-bucket>, with an
  // optional "public/" segment before the bucket for its public-read
  // variant - the bucket name itself must NOT be treated as the ownership
  // key (it's always "project-images"), only what comes after it.
  const match = /^object\/(?:public\/)?([^/]+)\/(.+)$/.exec(restPath);
  if (!match) return new Response("Not found", { status: 404 });
  const bucket = match[1];
  const pathInBucket = match[2];

  const authError = await authorizeStoragePath(pathInBucket, session, env);
  if (authError) return authError;

  const target = env.SUPABASE_URL + "/storage/v1/object/" + bucket + "/" + pathInBucket;
  const headers = new Headers();
  headers.set("apikey", env.SUPABASE_SERVICE_ROLE_KEY);
  headers.set("Authorization", "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY);
  const contentType = request.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);

  const init = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  const resp = await fetch(target, init);
  const respHeaders = new Headers(resp.headers);
  if (request.method === "GET" && resp.ok) {
    respHeaders.set("Cache-Control", "private, max-age=300");
  }
  return new Response(resp.body, { status: resp.status, headers: respHeaders });
}

// --- Auth: cookie-based session on top of Supabase Auth (GoTrue) -----------
//
// Two HttpOnly cookies hold the Supabase session: `sbat` (access token, a
// short-lived JWT) and `sbrt` (refresh token, capped at 30 days regardless of
// Supabase's own refresh-token lifetime - forces re-login at least monthly).
// Both are Secure + SameSite=Lax: this app only ever issues same-origin
// fetch() JSON calls (no HTML form posts), so SameSite=Lax alone already
// blocks the classic CSRF vector without needing a token scheme.
//
// isJwtExpired only decodes the payload to read `exp` - it does NOT verify
// the signature. That's intentional: this check exists purely to decide
// whether to show the app shell or redirect to /login.html. Real
// authorization happens downstream at PostgREST, which does verify the
// signature against the Supabase JWT secret on every /api/db/* and
// /api/storage/* call. Worst case of a forged sbat cookie: it passes this
// page-gate check but every subsequent proxied call still 401s at Supabase.
function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i === -1) return;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(str.length + ((4 - (str.length % 4)) % 4), "=");
  return atob(padded);
}

function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    return JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return null;
  }
}

function isJwtExpired(token, skewSeconds = 15) {
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) return true;
  return payload.exp * 1000 < Date.now() + skewSeconds * 1000;
}

function cookieAttrs(request) {
  const secure = new URL(request.url).protocol === "https:" ? "Secure; " : "";
  return secure + "HttpOnly; SameSite=Lax; Path=/";
}

function buildAuthCookies(request, { access_token, refresh_token, expires_in }) {
  const attrs = cookieAttrs(request);
  return [
    `sbat=${access_token}; ${attrs}; Max-Age=${expires_in || 3600}`,
    `sbrt=${refresh_token}; ${attrs}; Max-Age=${30 * 24 * 3600}`,
  ];
}

function clearAuthCookies(request) {
  const attrs = cookieAttrs(request);
  return [`sbat=; ${attrs}; Max-Age=0`, `sbrt=; ${attrs}; Max-Age=0`];
}

// Reads the session off the request's cookies, transparently refreshing an
// expired access token via the refresh token. Returns either
// { authenticated: false } or { authenticated: true, accessToken,
// setCookies? } - setCookies is only present when a refresh happened and the
// caller must append those Set-Cookie headers to its response.
async function getSession(request, env) {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const at = cookies.sbat;
  const rt = cookies.sbrt;
  if (!at && !rt) return { authenticated: false };
  if (at && !isJwtExpired(at)) return { authenticated: true, accessToken: at };
  if (!rt) return { authenticated: false };

  const resp = await fetch(env.SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: rt }),
  });
  if (!resp.ok) return { authenticated: false };
  const data = await resp.json();
  return {
    authenticated: true,
    accessToken: data.access_token,
    setCookies: buildAuthCookies(request, data),
  };
}

async function handleAuthLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid request" }), { status: 400 });
  }
  const resp = await fetch(env.SUPABASE_URL + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: body.email, password: body.password }),
  });
  if (!resp.ok) {
    return new Response(
      JSON.stringify({ error: "Ongeldige combinatie van e-mailadres en wachtwoord." }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }
  const data = await resp.json();
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const c of buildAuthCookies(request, data)) headers.append("Set-Cookie", c);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function handleAuthLogout(request, env) {
  const cookies = parseCookies(request.headers.get("Cookie"));
  if (cookies.sbat) {
    await fetch(env.SUPABASE_URL + "/auth/v1/logout", {
      method: "POST",
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + cookies.sbat },
    }).catch(() => {});
  }
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const c of clearAuthCookies(request)) headers.append("Set-Cookie", c);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

function handleAuthSession(session) {
  const payload = decodeJwtPayload(session.accessToken);
  return new Response(JSON.stringify({ email: payload ? payload.email : null }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Both "/login.html" and "/login" are listed because Cloudflare's static
// asset serving 307-redirects the former to the latter (clean-URL
// html_handling) - without both being public, that redirect would bounce
// straight back into this Worker's own unauthenticated page-gate below,
// which itself redirects to "/login", creating an infinite loop.
const PUBLIC_PATHS = new Set(["/login.html", "/login", "/api/auth/login"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (PUBLIC_PATHS.has(url.pathname)) {
      if (url.pathname === "/api/auth/login") return handleAuthLogin(request, env);
      return env.ASSETS.fetch(request);
    }
    if (url.pathname === "/api/auth/logout") {
      return handleAuthLogout(request, env);
    }

    const isApi = url.pathname.startsWith("/api/");
    const isStateChanging = request.method !== "GET" && request.method !== "HEAD";
    if (isApi && isStateChanging) {
      const secFetchSite = request.headers.get("Sec-Fetch-Site");
      if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
        return new Response(JSON.stringify({ error: "cross-site request rejected" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    const session = await getSession(request, env);
    if (!session.authenticated) {
      if (isApi) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return Response.redirect(new URL("/login", url).toString(), 302);
    }

    let response;
    if (url.pathname.startsWith("/api/db/")) {
      response = await handleDbProxy(request, url, env, session);
    } else if (url.pathname.startsWith("/api/storage/")) {
      response = await handleStorageProxy(request, url, env, session);
    } else if (url.pathname === "/api/auth/session") {
      response = handleAuthSession(session);
    } else {
      response = await env.ASSETS.fetch(request);
    }

    if (session.setCookies) {
      response = new Response(response.body, response);
      for (const c of session.setCookies) response.headers.append("Set-Cookie", c);
    }
    return response;
  },
};
