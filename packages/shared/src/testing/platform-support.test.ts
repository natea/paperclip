import { describe, expect, it } from "vitest";
import { hostPlatformSupports, unsupportedPlatformReason } from "./platform-support.js";

describe("host platform support guards", () => {
  it("admits only Linux for namespace-backed subjects", () => {
    expect(hostPlatformSupports("linux-namespaces", "linux")).toBe(true);
    expect(hostPlatformSupports("linux-namespaces", "darwin")).toBe(false);
    expect(hostPlatformSupports("linux-namespaces", "win32")).toBe(false);
  });

  it("admits only procfs hosts for /proc/net readers", () => {
    expect(hostPlatformSupports("proc-net", "linux")).toBe(true);
    expect(hostPlatformSupports("proc-net", "darwin")).toBe(false);
    expect(unsupportedPlatformReason("proc-net", "darwin")).toBe(
      "requires a readable /proc/net/tcp (Linux procfs); host is darwin",
    );
  });

  it("admits every non-Windows host for POSIX subjects", () => {
    expect(hostPlatformSupports("posix", "linux")).toBe(true);
    expect(hostPlatformSupports("posix", "darwin")).toBe(true);
    expect(hostPlatformSupports("posix", "win32")).toBe(false);
  });

  it("explains the skip in terms of the missing capability, not the bare platform check", () => {
    expect(unsupportedPlatformReason("linux-namespaces", "linux")).toBeNull();
    expect(unsupportedPlatformReason("linux-namespaces", "darwin")).toBe(
      "requires Linux kernel namespaces (Bubblewrap, forced loopback binds); host is darwin",
    );
  });
});
