/** Decode a dynamic route segment without throwing on a malformed % escape (audit L4). */
export function decodeParam(v: string): string | null {
  try {
    return decodeURIComponent(v);
  } catch {
    return null;
  }
}
