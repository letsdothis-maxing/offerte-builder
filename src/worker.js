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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/db/")) {
      return handleDbProxy(request, url, env);
    }
    return env.ASSETS.fetch(request);
  },
};
