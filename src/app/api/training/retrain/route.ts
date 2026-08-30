import { route } from "@/lib/api/http.ts";
import { learningService } from "@/lib/api/service.ts";
import { clearTrainingData, retrainProfiles } from "@/lib/api/learning.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

/** POST /api/training/retrain — rebuild every profile. Runs inline: it is an
 *  aggregate over stored vectors, not a re-analysis. */
export const POST = route(async () => {
  const userId = await requireUserId();
  return Response.json(await retrainProfiles(learningService(userId)));
});

/** DELETE /api/training/retrain — forget everything learned so far. */
export const DELETE = route(async () => {
  const userId = await requireUserId();
  return Response.json(await clearTrainingData(learningService(userId)));
});
