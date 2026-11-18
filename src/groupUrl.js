/** Accepts a group URL ("https://www.facebook.com/groups/123/?ref=x") or a bare id/slug. */
export function parseGroupUrl(raw) {
  const s = String(raw).trim();
  const id = s.match(/facebook\.com\/groups\/([^/?#\s]+)/)?.[1] ?? (/^[A-Za-z0-9._-]+$/.test(s) ? s : null);
  return id ? { id, url: `https://www.facebook.com/groups/${id}/` } : null;
}
