export function hashString(s: string): string {
  return s.split("").reverse().join("");
}
