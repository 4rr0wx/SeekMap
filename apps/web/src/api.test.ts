import { afterEach, describe, expect, it, vi } from "vitest";
import { remove } from "./api";

describe("API request headers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not advertise an empty DELETE request as JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await remove("/api/game", "seeker-token");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(headers.has("Content-Type")).toBe(false);
    expect(headers.get("Authorization")).toBe("Bearer seeker-token");
    expect(init.cache).toBe("no-store");
  });

  it("sends cache: no-store on API requests to bypass browser cache", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { currentGame } = await import("./api");
    await currentGame("hider-token");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.cache).toBe("no-store");
  });
});
