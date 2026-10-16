// JWT session for the Django API. Tokens live in sessionStorage (cleared when the tab closes). Any script running on
// the page can read them, so the app must never render untrusted HTML.

const ACCESS = "pt.access";
const REFRESH = "pt.refresh";
export const AUTH_EVENT = "pt:auth";

const read = (k: string) => {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
};

export const getAccessToken = () => read(ACCESS);
export const getRefreshToken = () => read(REFRESH);
export const hasSession = () => Boolean(getRefreshToken() || getAccessToken());

export function saveTokens(access: string, refresh?: string) {
  try {
    sessionStorage.setItem(ACCESS, access);
    if (refresh) sessionStorage.setItem(REFRESH, refresh);
  } catch {
    // Storage blocked: the session lasts until reload only.
  }
  window.dispatchEvent(new Event(AUTH_EVENT));
}

export function clearTokens() {
  try {
    sessionStorage.removeItem(ACCESS);
    sessionStorage.removeItem(REFRESH);
  } catch {
    // ignore
  }
  window.dispatchEvent(new Event(AUTH_EVENT));
}
