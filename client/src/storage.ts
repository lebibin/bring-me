/**
 * localStorage that degrades to no-op — sandboxed iframes (the itch.io embed)
 * can block storage entirely, and preferences aren't worth crashing over.
 */

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* blocked — the preference just won't survive the session */
  }
}
