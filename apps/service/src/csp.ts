// The content security policy the service sends on every answer (ADR 0010, ADR 0085): strict, nothing inline,
// nothing from elsewhere; fonts only as files of the app's own origin, images as files or `data:`. Written once: the
// API sends it (`api.ts`), the build test checks what the web build emits against it, and `proof` serves its bite page
// under it, so none of them holds a copy that could drift.
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
].join("; ");
