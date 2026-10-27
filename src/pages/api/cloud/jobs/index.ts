// Cloud AI jobs: GET lists your recent jobs; POST submits one (reserves credits and budget atomically, then queues it).
export const prerender = false;

import type { APIRoute } from "astro";
import { cloudConfig } from "../../../../lib/cloud/config";
import { listJobs, reserveJob } from "../../../../lib/cloud/db";
import { FeatureParamsError, getFeature } from "../../../../lib/cloud/features";
import { allowanceFor, identify } from "../../../../lib/cloud/identity";
import { apiError, fromError, json, publicJob } from "../../../../lib/cloud/http";
import { ownsUploadPath, storageConfigured } from "../../../../lib/cloud/storage";
import { verifyTurnstile } from "../../../../lib/cloud/turnstile";
import { ensureWorker } from "../../../../lib/cloud/worker";
import { LIMITS, rateLimit, tooManyRequests } from "../../../../lib/net/rate-limit";

export const GET: APIRoute = async ({ request, clientAddress }) => {
  const id = await identify(request, clientAddress);
  const wait = rateLimit("cloud-read", id.ip, LIMITS.cloudRead);
  if (wait) return tooManyRequests(wait);
  if (!cloudConfig().databaseUrl) return apiError("not_configured");
  try {
    return json({ jobs: (await listJobs(id.userKey, 20)).map(publicJob) });
  } catch (e) {
    return fromError(e);
  }
};

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const id = await identify(request, clientAddress);
  const wait = rateLimit("cloud-create", id.ip, LIMITS.cloudCreate);
  if (wait) return tooManyRequests(wait);
  const c = cloudConfig();
  if (!c.databaseUrl) return apiError("not_configured");

  let body: { feature?: unknown; params?: unknown; consent?: unknown; turnstileToken?: unknown; uploads?: unknown };
  try {
    body = await request.json();
  } catch {
    return apiError("invalid_params");
  }
  const feature = typeof body.feature === "string" ? getFeature(body.feature) : undefined;
  if (!feature || (feature.devOnly && !c.devFeatures)) return apiError("unknown_feature");
  if (feature.requiresSignIn && !id.signedIn) return apiError("sign_in_required");

  const uploads = Array.isArray(body.uploads) ? body.uploads.filter((u): u is string => typeof u === "string") : [];
  if (feature.uploadsMedia) {
    if (!storageConfigured()) return apiError("storage_not_configured");
    if (body.consent !== true) return apiError("consent_required");
    if (!id.userId || uploads.some((p) => !ownsUploadPath(id.userId!, p))) return apiError("upload_not_allowed");
  } else if (uploads.length) return apiError("invalid_params", "This feature doesn't take uploads.");

  const human = await verifyTurnstile(typeof body.turnstileToken === "string" ? body.turnstileToken : undefined, id.ip);
  if (!human.ok) return apiError("turnstile_failed");

  let params: unknown;
  try {
    params = feature.parse(body.params);
  } catch (e) {
    return apiError("invalid_params", e instanceof FeatureParamsError ? e.message : undefined);
  }
  const est = feature.estimate(params);
  try {
    const job = await reserveJob({ userKey: id.userKey, userId: id.userId, feature: feature.id, params, credits: est.credits, usd: est.usd, allowance: allowanceFor(id), maxActive: c.maxActiveJobs, consent: body.consent === true, uploadPaths: uploads });
    ensureWorker();
    return json({ job: publicJob(job) }, 201);
  } catch (e) {
    return fromError(e);
  }
};
