// Fixture: exported symbols with typed signatures. Overloaded `parseToken`
// locks ADR-007 amendment (3): the implementation signature is NOT part of
// the fact - only the public overload signatures are.
import { hashString } from "./util";

export const MAX_TRIES = 3;

export interface Session {
  user: string;
  expires: number;
}

export function login(user: string, pass: string): Session | null {
  if (hashString(pass).length > MAX_TRIES) {
    return { user, expires: 3600 };
  }
  return null;
}

export function parseToken(raw: string): Session;
export function parseToken(raw: Uint8Array): Session;
export function parseToken(raw: string | Uint8Array): Session {
  const s = typeof raw === "string" ? raw : "bin";
  return { user: s, expires: 0 };
}
