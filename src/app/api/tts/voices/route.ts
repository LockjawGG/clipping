import { route } from "@/lib/api/http.ts";
import { getTts } from "@/lib/tts/index.ts";
import { ProviderUnavailableError } from "@/lib/providers/types.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

/**
 * GET /api/tts/voices — installed voices.
 *
 * An unconfigured provider is not an error here: the UI needs to be able to
 * tell the user *why* there are no voices, so the hint comes back with an
 * empty list rather than as a 503.
 */
export const GET = route(async () => {
  await requireUserId();
  try {
    return Response.json({ voices: await getTts().voices(), available: true, hint: null });
  } catch (err) {
    const hint = err instanceof ProviderUnavailableError ? err.hint : "text-to-speech is not configured";
    return Response.json({ voices: [], available: false, hint });
  }
});
