// Thin same-origin proxy to Supabase's PostgREST API: the frontend calls
// /api/db/<table>?<postgrest-query>, this injects the Supabase apikey/
// Authorization headers server-side (never shipped to the client) and
// forwards to <SUPABASE_URL>/rest/v1/<table>?<...>. Keeps the anon key out
// of public/index.html entirely.
async function handleDbProxy(request, url, env) {
  const restPath = url.pathname.slice("/api/db/".length);
  const target = env.SUPABASE_URL + "/rest/v1/" + restPath + url.search;
  const headers = new Headers();
  headers.set("apikey", env.SUPABASE_ANON_KEY);
  headers.set("Authorization", "Bearer " + env.SUPABASE_ANON_KEY);
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
// tab. Uploads/deletes need the service-role key (bucket writes aren't
// allowed for the anon key and this is a single-user internal tool, so
// there's no per-user policy to enforce) - that key stays server-side here,
// same as the anon key does for handleDbProxy. Public reads are just
// redirected straight to Supabase's own public object URL instead of
// proxying the image bytes through the Worker.
async function handleStorageProxy(request, url, env) {
  const restPath = url.pathname.slice("/api/storage/".length);
  const target = env.SUPABASE_URL + "/storage/v1/" + restPath;
  if (request.method === "GET" && restPath.startsWith("object/public/")) {
    return Response.redirect(target, 302);
  }
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
  return new Response(resp.body, resp);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/db/")) {
      return handleDbProxy(request, url, env);
    }
    if (url.pathname.startsWith("/api/storage/")) {
      return handleStorageProxy(request, url, env);
    }
    return env.ASSETS.fetch(request);
  },
};
