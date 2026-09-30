import { describe, it, expect } from "vitest";
import { formatReportAsMarkdown, type BenchmarkReport } from "./benchmark";

function makeReport(overrides: Partial<BenchmarkReport> = {}): BenchmarkReport {
  return {
    environment: {
      cpuCores: 8,
      deviceMemoryGb: 8,
      webgpuAvailable: true,
      webgpuAdapterInfo: { vendor: "apple", architecture: "common-3", description: "" },
      userAgent: "test-agent",
    },
    measurements: [
      {
        case: { id: "image-720p", kind: "image", width: 1280, height: 720 },
        ok: true,
        modelUsed: "u2net",
        inferenceTimeMs: 120,
        totalTimeMs: 180,
        peakMemoryBytes: 5_000_000,
        gpuMemoryBytes: null,
        throughputFps: 5.55,
      },
    ],
    generatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("formatReportAsMarkdown", () => {
  it("includes environment details and a measurement row for a successful case", () => {
    const md = formatReportAsMarkdown(makeReport());
    expect(md).toContain("CPU cores: 8");
    expect(md).toContain("WebGPU available: yes");
    expect(md).toContain("apple / common-3");
    expect(md).toContain("image-720p");
    expect(md).toContain("1280×720");
    expect(md).toContain("u2net");
    expect(md).toContain("120ms");
    expect(md).toContain("180ms");
    expect(md).toContain("5.55 fps");
  });

  it("reports GPU memory as unavailable rather than fabricating a number", () => {
    const md = formatReportAsMarkdown(makeReport());
    expect(md).toContain("no browser API");
  });

  it("surfaces a failed case's error instead of silently omitting it", () => {
    const md = formatReportAsMarkdown(
      makeReport({
        measurements: [
          {
            case: { id: "video-1080p-8fps", kind: "video", width: 1920, height: 1080, fps: 8 },
            ok: false,
            error: "No eligible model for this request",
            inferenceTimeMs: 0,
            totalTimeMs: 42,
            peakMemoryBytes: null,
            gpuMemoryBytes: null,
            throughputFps: 0,
          },
        ],
      }),
    );
    expect(md).toContain("FAILED: No eligible model for this request");
    expect(md).toContain("1920×1080 @8fps");
  });

  it("reports unknown WebGPU/device-memory info honestly rather than guessing", () => {
    const md = formatReportAsMarkdown(
      makeReport({
        environment: {
          cpuCores: 4,
          deviceMemoryGb: null,
          webgpuAvailable: false,
          webgpuAdapterInfo: null,
          userAgent: "test-agent-2",
        },
      }),
    );
    expect(md).toContain("Device memory: unknown");
    expect(md).toContain("WebGPU available: no");
  });
});
