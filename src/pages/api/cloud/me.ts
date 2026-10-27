// Cloud AI: who you are, today's credits, and which cloud features this server offers.
export const prerender = false;

import type { APIRoute } from "astro";
import { cloudConfig, cloudConfigProblems } from "../../../lib/cloud/config";
import { getBalance } from "../../../lib/cloud/db";
import { CLOUD_FEATURES } from "../../../lib/cloud/features";
import { allowanceFor, identify } from "../../../lib/cloud/identity";
import { fromError, json, secondsUntilReset } from "../../../lib/cloud/http";
import { storageConfigured } from "../../../lib/cloud/storage";
import { ensureWorker } from "../../../lib/cloud/worker";
import { LIMITS, rateLimit, tooManyRequests } from "../../../lib/net/rate-limit";

export const GET: APIRoute = async ({ request, clientAddress }) => {
  const id = await identify(request, clientAddress);
  const wait = rateLimit("cloud-read", id.ip, LIMITS.cloudRead);
  if (wait) return tooManyRequests(wait);
  const c = cloudConfig();
  if (!c.databaseUrl) return json({ configured: false, signedIn: id.signedIn, problems: cloudConfigProblems(c) });
  ensureWorker();
  try {
    const credits = await getBalance(id.userKey, allowanceFor(id));
    return json({
      configured: true,
      signedIn: id.signedIn,
      email: id.email,
      credits: { ...credits, resetsInSec: secondsUntilReset() },
      features: CLOUD_FEATURES.filter((f) => !f.devOnly || c.devFeatures).map((f) => ({
        id: f.id,
        label: f.label,
        requiresSignIn: f.requiresSignIn,
        uploadsMedia: f.uploadsMedia,
        available: (!f.requiresSignIn || id.signedIn) && (!f.uploadsMedia || storageConfigured()),
      })),
    });
  } catch (e) {
    return fromError(e);
  }
};
