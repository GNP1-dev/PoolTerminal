/*
 * koios-token.js - optional Koios API token (tier 1 = 50,000 calls/day).
 *
 * Authenticated Koios calls bypass the public-IP rate block: a request carrying
 * a valid Bearer token is served even when the same IP is blocked for anonymous
 * traffic. The token is read from localStorage on load and may be set by the
 * wizard's Koios step, the Settings dialog, or the console (for testing).
 *
 * Both koios-query.js and koios-history.js route their curl commands through
 * withKoiosAuth() so the header is attached in exactly one place.
 */

const TOKEN_KEY = 'pt.koios.token';

let _token = null;
try { _token = (localStorage.getItem(TOKEN_KEY) || '').trim() || null; } catch (e) { _token = null; }

/** Set (or clear, with empty/null) the Koios token and persist it. */
export function setKoiosToken(t) {
  _token = (t && String(t).trim()) || null;
  try {
    if (_token) localStorage.setItem(TOKEN_KEY, _token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (e) { /* ignore storage errors */ }
}

/** The current token, or null. */
export function getKoiosToken() { return _token; }

/** True if a token is configured. */
export function hasKoiosToken() { return !!_token; }

/**
 * Inject the Authorization header into a Koios curl command if a token is set.
 * JWTs contain only [A-Za-z0-9_-.], so single-quoting the value is safe.
 */
export function withKoiosAuth(command) {
  if (!_token) return command;
  if (typeof command !== 'string' || !command.startsWith('curl ')) return command;
  return command.replace(/^curl /, `curl -H 'Authorization: Bearer ${_token}' `);
}
