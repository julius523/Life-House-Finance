/**
 * Allowlist of MIME types that are safe to upload and associate with receipts.
 * Excludes active-content types (HTML, SVG, JavaScript, XML, XHTML, etc.)
 * that could execute scripts when served from the same origin.
 *
 * This is the single source of truth — both the upload endpoint and the
 * receipt creation endpoint reference this set so they cannot drift apart.
 */
export const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/tiff",
  "image/avif",
  "application/pdf",
  "text/plain",
  "text/csv",
]);

/**
 * Returns true when the given MIME type is on the safe allowlist.
 * The content-type value is normalised before comparison (parameters such as
 * `; charset=utf-8` are stripped and the result is lower-cased).
 */
export function isAllowedMimeType(contentType: string): boolean {
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  return ALLOWED_UPLOAD_MIME_TYPES.has(normalized);
}
