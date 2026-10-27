// One cloud AI job: GET its status/result; DELETE cancels it if it hasn't started (full refund).
export const prerender = false;

import type { APIRoute } from "astro";
import { cloudConfig } from "../../../../lib/cloud/config";
import { cancelJob, getJob } from "../../../../lib/cloud/db";
import { identify } from "../../../../lib/cloud/identity";
import { apiError, fromError, json, publicJob } from "../../../../lib/cloud/http";
import { LIMITS, rateLimit, tooManyRequests } from "../../../../lib/net/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: APIRoute = async ({ params, request, clientAddress }) => {
  const id = await identify(request, clientAddress);
  const wait = rateLimit("cloud-read", id.ip, LIMITS.cloudRead);
  if (wait) return tooManyRequests(wait);
  if (!cloudConfig().databaseUrl) return apiError("not_configured");
  if (!params.id || !UUID.test(params.id)) return apiError("not_found");
  try {
    const job = await getJob(params.id, id.userKey);
    return job ? json({ job: publicJob(job) }) : apiError("not_found");
  } catch (e) {
    return fromError(e);
  }
};

export const DELETE: APIRoute = async ({ params, request, clientAddress }) => {
  const id = await identify(request, clientAddress);
  const wait = rateLimit("cloud-create", id.ip, LIMITS.cloudCreate);
  if (wait) return tooManyRequests(wait);
  if (!cloudConfig().databaseUrl) return apiError("not_configured");
  if (!params.id || !UUID.test(params.id)) return apiError("not_found");
  try {
    const cancelled = await cancelJob(params.id, id.userKey);
    return json({ cancelled });
  } catch (e) {
    return fromError(e);
  }
};
