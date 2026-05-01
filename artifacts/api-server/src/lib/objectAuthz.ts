import {
  db,
  uploadedObjectsTable,
  receiptsTable,
  type UploadedObject,
} from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import type { AuthUser } from "./auth";

/**
 * Resolve the canonical legacy uploader of a private object.
 *
 * For objects predating the uploaded_objects bookkeeping table we fall back
 * to receipts.uploadedBy. When multiple receipts point at the same fileUrl
 * we accept ONLY the earliest (oldest createdAt) row — this defeats
 * historical poisoning where an attacker may have post-hoc inserted a
 * second receipt row referencing someone else's fileUrl in order to claim
 * read access. The earliest uploader is the one who originally registered
 * the object and is therefore the trusted owner.
 */
async function getLegacyUploaderId(
  objectPath: string,
): Promise<number | null> {
  const [row] = await db
    .select({ uploadedBy: receiptsTable.uploadedBy })
    .from(receiptsTable)
    .where(eq(receiptsTable.fileUrl, objectPath))
    .orderBy(asc(receiptsTable.createdAt), asc(receiptsTable.id))
    .limit(1);
  if (!row || row.uploadedBy == null) return null;
  return row.uploadedBy;
}
/**
 * Look up the uploader bookkeeping row for a private object path.
 * Returns null when the object was never registered through the
 * `/storage/uploads/request-url` endpoint (e.g. legacy data).
 */
export async function getUploadedObject(
  objectPath: string,
): Promise<UploadedObject | null> {
  const [row] = await db
    .select()
    .from(uploadedObjectsTable)
    .where(eq(uploadedObjectsTable.objectPath, objectPath))
    .limit(1);
  return row ?? null;
}

/**
 * Authorization for "consuming" a freshly-uploaded object — i.e. attaching
 * it to a receipt or sending it to the AI bank-statement parser. Only the
 * original uploader (or an admin) may reference the object. This blocks
 * IDOR-style cross-user reuse of presigned object paths.
 */
export async function canConsumeUpload(
  user: AuthUser,
  objectPath: string,
): Promise<boolean> {
  if (user.role === "admin") return true;
  const row = await getUploadedObject(objectPath);
  if (row) return row.uploadedBy === user.id;
  // Legacy fallback for pre-uploaded_objects data, hardened against
  // historical fileUrl poisoning (see getLegacyUploaderId).
  const ownerId = await getLegacyUploaderId(objectPath);
  return ownerId !== null && ownerId === user.id;
}

/**
 * Authorization for downloading a private object via /storage/objects/*.
 *
 * Allowed when:
 *  - caller is admin or approver (cross-team review of receipts), OR
 *  - caller is the original uploader of this object.
 *
 * Submitters cannot read other users' uploads even if a receipt row points
 * at the same path — that bug was the original IDOR.
 */
export async function canReadObject(
  user: AuthUser,
  objectPath: string,
): Promise<boolean> {
  if (user.role === "admin" || user.role === "approver") return true;
  const row = await getUploadedObject(objectPath);
  if (row) return row.uploadedBy === user.id;
  const ownerId = await getLegacyUploaderId(objectPath);
  return ownerId !== null && ownerId === user.id;
}
