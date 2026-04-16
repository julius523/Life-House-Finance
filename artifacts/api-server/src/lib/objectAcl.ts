import { File } from "@google-cloud/storage";

export enum ObjectPermission {
  READ = "read",
  WRITE = "write",
}

export interface ObjectAclPolicy {
  visibility: "public" | "private";
}

const ACL_METADATA_KEY = "acl-policy";

export async function setObjectAclPolicy(
  file: File,
  policy: ObjectAclPolicy,
): Promise<void> {
  await file.setMetadata({
    metadata: { [ACL_METADATA_KEY]: JSON.stringify(policy) },
  });
}

export async function getObjectAclPolicy(
  file: File,
): Promise<ObjectAclPolicy | null> {
  const [metadata] = await file.getMetadata();
  const raw = metadata.metadata?.[ACL_METADATA_KEY];
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as ObjectAclPolicy;
  } catch {
    return null;
  }
}
