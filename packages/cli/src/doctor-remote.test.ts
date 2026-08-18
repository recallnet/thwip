import { describe, expect, it, vi } from "vitest";
import { readDoctorProbe } from "./doctor-remote.js";
import type { DoctorProbe } from "./queue-doctor.js";

const probe: DoctorProbe = {
  section: "repository",
  operation: "control-plane.repository.resolve",
  method: "GET",
  path: "/v1/resolve-repo?name=acme%2Frepo",
  requiresAdmin: false,
};

describe("doctor remote reads", () => {
  it.each([429, 500, 502, 503, 504])("retries HTTP %s and returns the successful read", async (status) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status }))
      .mockResolvedValueOnce(Response.json({ repositoryId: "123" }));
    const pause = vi.fn(async () => {});

    await expect(readDoctorProbe({ endpoint: "https://thwip.test", auth: "Bearer secret", path: probe.path, probe }, { fetch: fetcher, pause })).resolves.toMatchObject({
      status: 200,
      attempts: 2,
      operation: "control-plane.repository.resolve",
      body: { repositoryId: "123" },
    });
    expect(pause).toHaveBeenCalledOnce();
  });

  it("stops after three network failures without exposing authorization", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
    const result = await readDoctorProbe(
      { endpoint: "https://thwip.test", auth: "Bearer secret", path: probe.path, probe },
      { fetch: fetcher, pause: async () => {} },
    );

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      section: "repository",
      operation: "control-plane.repository.resolve",
      attempts: 3,
      status: 0,
      body: null,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("does not retry a permanent refusal", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 }));
    await expect(readDoctorProbe(
      { endpoint: "https://thwip.test", auth: "Bearer secret", path: probe.path, probe },
      { fetch: fetcher, pause: async () => {} },
    )).resolves.toMatchObject({ status: 403, attempts: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
