import { randomBytes } from "node:crypto";

/** Collision-safe prefixed ids, e.g. sess_9f3ab2c1d4e5. */
export function nanoid(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}
