/**
 * Wire protocol version. Bump MAJOR for breaking envelope changes, MINOR for
 * additive commands/events. Daemon and client negotiate on connect.
 */
export const PROTOCOL_VERSION = { major: 0, minor: 1 } as const;

export function isCompatible(remote: { major: number; minor: number }): boolean {
  return remote.major === PROTOCOL_VERSION.major && remote.minor <= PROTOCOL_VERSION.minor;
}
