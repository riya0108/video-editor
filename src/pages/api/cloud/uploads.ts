// Cloud AI uploads: a signed-in user asks for a short-lived URL to upload one file into their own folder of the private
// `cloud-uploads` bucket. The file goes straight from the browser to storage and is deleted 24 h after its job ends.
export const prerender = false;

import type { APIRoute } from "astro";
import { getFeature } from "../../../lib/cloud/features";
import { identify } from "../../../lib/cloud/identity";
import { apiError, json } from "../../../lib/cloud/http";
import { createSignedUpload, MAX_UPLOAD_BYTES, storageConfigured, uploadPathFor } from "../../../lib/cloud/storage";
import { LIMITS, rateLimit, tooManyRequests } from "../../../lib/net/rate-limit";

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const id = await identify(request, clientAddress);
  const wait = rateLimit("cloud-upload", id.ip, LIMITS.cloudUpload);
  if (wait) return tooManyRequests(wait);
  if (!id.signedIn || !id.userId) return apiError("sign_in_required");
  if (!storageConfigured()) return apiError("storage_not_configured");
  let body: { feature?: unknown; fileName?: unknown; size?: unknown; type?: unknown };
  try {
    body = await request.json();
  } catch {
    return apiError("invalid_params");
  }
  const feature = typeof body.feature === "string" ? getFeature(body.feature) : undefined;
  if (!feature?.uploadsMedia) return apiError("unknown_feature");
  if (typeof body.fileName !== "string" || typeof body.size !== "number" || body.size <= 0) return apiError("invalid_params");
  if (body.size > MAX_UPLOAD_BYTES) return apiError("invalid_params", "That file is too large (200 MB max).");
  if (typeof body.type !== "string" || !/^(audio|video|image)\//.test(body.type)) return apiError("invalid_params", "Only audio, video or image files can be uploaded.");
  try {
    const path = uploadPathFor(id.userId, body.fileName);
    const signed = await createSignedUpload(path);
    return json({ path, url: signed.url, token: signed.token });
  } catch (e) {
    console.error("[cloud] upload sign failed:", (e as Error).message);
    return apiError("server_error", "Couldn't prepare the upload. Please try again.");
  }
};
