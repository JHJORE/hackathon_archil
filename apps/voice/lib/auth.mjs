// Endpoints that spend credits or place calls require VOICE_ACCESS_KEY
// (header x-voice-key or ?key=). With no key set, they are open: local development only.
export function authorized(req) {
  const key = process.env.VOICE_ACCESS_KEY;
  if (!key) return true;
  return (req.headers.get("x-voice-key") || new URL(req.url).searchParams.get("key")) === key;
}

// ElevenLabs calls the price_check webhook from its servers, so it needs a public HTTPS URL
// (deployment or a tunnel such as `cloudflared tunnel --url http://localhost:4320`).
export function publicBaseUrl() {
  const u = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (!/^https:\/\//.test(u)) {
    throw new Error("Set PUBLIC_BASE_URL to a public https URL that reaches this server, so ElevenLabs can call the price check. Calls are blocked until then.");
  }
  return u;
}
