import { route } from "@/lib/api/http.ts";
import { localRouteDeps, serveLocalFile, storeLocalFile } from "@/lib/api/local-storage.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ key: string[] }> };

/** GET /api/storage/local/<key>?action=get&token=… — stream a stored file. */
export const GET = route<Ctx>(async (req, { params }) => {
  const { key } = await params;
  const token = new URL(req.url).searchParams.get("token");
  return serveLocalFile(localRouteDeps(), key, token);
});

/** PUT /api/storage/local/<key>?action=put&token=… — receive a direct upload. */
export const PUT = route<Ctx>(async (req, { params }) => {
  const { key } = await params;
  const token = new URL(req.url).searchParams.get("token");
  return storeLocalFile(localRouteDeps(), key, token, req);
});
