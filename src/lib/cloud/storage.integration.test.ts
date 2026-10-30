import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createSignedDownload, createSignedUpload, deleteUploads, storageConfigured, uploadPathFor } from "./storage";

/**
 * UPLOAD ROUND TRIP against the real `cloud-uploads` bucket: sign an upload URL, upload a file the way the browser
 * does, read it back through a signed download URL, then delete it and confirm it's gone. Skipped unless
 * CLOUD_TEST_STORAGE=1 (it needs SUPABASE_SECRET_KEY in .env and touches real storage).
 *
 *   CLOUD_TEST_STORAGE=1 npx vitest run src/lib/cloud/storage.integration.test.ts
 */
describe.skipIf(process.env.CLOUD_TEST_STORAGE !== "1")("cloud uploads (real Supabase Storage)", () => {
  it("uploads to a signed URL, downloads it back, and deletes it", async () => {
    expect(storageConfigured()).toBe(true);
    const path = uploadPathFor(randomUUID(), "voice sample.wav");
    const body = new Uint8Array(4096).map((_, i) => i % 251);

    const { url } = await createSignedUpload(path);
    const put = await fetch(url, { method: "PUT", headers: { "Content-Type": "audio/wav" }, body });
    expect(put.status, await put.clone().text()).toBe(200);

    const download = await createSignedDownload(path, 60);
    const got = new Uint8Array(await (await fetch(download)).arrayBuffer());
    expect(got).toEqual(body);

    // The bucket only takes audio/video/image.
    const bad = await createSignedUpload(uploadPathFor(randomUUID(), "x.txt"));
    const refused = await fetch(bad.url, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "hello" });
    expect(refused.ok).toBe(false);

    await deleteUploads([path]);
    const after = await fetch(download);
    expect(after.ok).toBe(false);
  }, 60_000);
});
