import { describe, expect, it } from "vitest";
import { resolveApiUrl } from "../../../web/src/lib/api";

describe("resolveApiUrl", () => {
  it("keeps the local root console API at /api", () => {
    expect(resolveApiUrl("/api/status", "http://127.0.0.1:43210/?token=secret")).toBe(
      "http://127.0.0.1:43210/api/status",
    );
  });

  it("resolves the API below an authenticated path mount", () => {
    expect(
      resolveApiUrl(
        "/api/config?profile=aria",
        "https://console.example/admin-api/aria-console/",
      ),
    ).toBe("https://console.example/admin-api/aria-console/api/config?profile=aria");
  });

  it("uses the containing directory when index.html is requested explicitly", () => {
    expect(
      resolveApiUrl(
        "/api/profiles",
        "https://console.example/admin-api/aria-console/index.html",
      ),
    ).toBe("https://console.example/admin-api/aria-console/api/profiles");
  });
});
