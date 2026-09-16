/**
 * Host-platform guards for suites whose *subject* only exists on some platforms.
 *
 * Some production code paths are deliberately platform-scoped — Bubblewrap
 * sandboxing and namespace-forced loopback binding are Linux kernel features,
 * and the modules implementing them throw on anything else. A suite that
 * exercises those paths is not "red on macOS" in any meaningful sense: it is
 * asserting behaviour the host cannot produce. Left unguarded, those tests
 * become permanent reds on every developer laptop, and a permanent red is a
 * gate nobody can read.
 *
 * Guard such tests with these predicates rather than an inline
 * `process.platform === "linux"` comparison. The literal comparison says only
 * *what* is checked; a named requirement plus `unsupportedPlatformReason`
 * records *why*, so the next reader does not have to rediscover that the skip
 * is a property of the kernel and not a disabled test.
 *
 * Deliberately free of any test-framework import: callers pair these with
 * `it.runIf(...)` / `describe.skipIf(...)` from their own runner.
 */

/** A capability a test's subject needs from the host OS. */
export type HostPlatformRequirement =
  /** Linux kernel namespaces: Bubblewrap sandboxing, forced loopback binds. */
  | "linux-namespaces"
  /**
   * Readable `/proc/net/tcp[6]`. `readListenerBindFacts` returns null without
   * it and the loopback-bind diagnosis deliberately stays silent, so any test
   * asserting that diagnosis needs a procfs host.
   */
  | "proc-net"
  /** Any POSIX host — process groups, signals, but not Windows. */
  | "posix";

const REQUIREMENT_PLATFORMS: Record<HostPlatformRequirement, (platform: NodeJS.Platform) => boolean> = {
  "linux-namespaces": (platform) => platform === "linux",
  "proc-net": (platform) => platform === "linux",
  posix: (platform) => platform !== "win32",
};

const REQUIREMENT_DESCRIPTIONS: Record<HostPlatformRequirement, string> = {
  "linux-namespaces": "Linux kernel namespaces (Bubblewrap, forced loopback binds)",
  "proc-net": "a readable /proc/net/tcp (Linux procfs)",
  posix: "a POSIX host",
};

/** True when `platform` can actually run a subject needing `requirement`. */
export function hostPlatformSupports(
  requirement: HostPlatformRequirement,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return REQUIREMENT_PLATFORMS[requirement](platform);
}

/**
 * A human-readable reason the current host cannot run the subject, or `null`
 * when it can. Suitable for a skip annotation or a log line.
 */
export function unsupportedPlatformReason(
  requirement: HostPlatformRequirement,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (hostPlatformSupports(requirement, platform)) return null;
  return `requires ${REQUIREMENT_DESCRIPTIONS[requirement]}; host is ${platform}`;
}
