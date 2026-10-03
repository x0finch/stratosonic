import { checkUploadKey, isAscii } from "./keys";

/**
 * The upload check's own work (#141), apart from its R2 calls so
 * scripts/bench-files.ts can time it: which keys to look for, grouped by
 * the folder they are listed in, and which of a listing's objects they
 * are. The route (api/files.ts, `POST /api/files/uploads/check`) makes the
 * calls.
 */

/**
 * The most keys one `POST /api/files/uploads/check` takes; the body cap is
 * sized for it. Checking each against the upload rules is most of the
 * request's CPU: 500 keep the worst case well inside 10 ms (bench-files.ts).
 */
export const CHECK_BATCH = 500;

/** A key of an upload check that already exists. */
export interface ExistingKey {
  /** The key as the check was given it. */
  readonly key: string;
  /** The key as R2 answered it: as listed, or as `head()` answered it. */
  readonly storedKey: string;
  readonly size: number;
  readonly uploadedAt: string;
}

/** Folder (as given, ending in `/` or `""`) -> name in NFC -> the keys asked with that name. */
export type CheckGroups = Map<string, Map<string, string[]>>;

/** A name in NFC; an ASCII name is its own. */
export function inNfc(name: string): string {
  return isAscii(name) ? name : name.normalize("NFC");
}

/**
 * The keys to look for, each once, grouped by folder and then by name in
 * NFC, in the order given. A key the upload rules refuse (`checkUploadKey`
 * under `prefix`) is left out: the check does not report it.
 */
export function groupCheckKeys(prefix: string, keys: readonly string[]): CheckGroups {
  const folders: CheckGroups = new Map();
  for (const key of new Set(keys)) {
    const checked = checkUploadKey(key, prefix);
    if ("error" in checked) {
      continue;
    }
    const slash = key.lastIndexOf("/");
    const folder = key.slice(0, slash + 1);
    // The checked key is in NFC past `prefix`, which ends in `/`, so its
    // name is the asked one in NFC already.
    const name = checked.key.slice(checked.key.lastIndexOf("/") + 1);
    let names = folders.get(folder);
    if (names === undefined) {
      names = new Map();
      folders.set(folder, names);
    }
    const same = names.get(name);
    if (same === undefined) {
      names.set(name, [key]);
    } else {
      same.push(key);
    }
  }
  return folders;
}

/** One object of a listing, as the check reads it. */
export interface ListedObject {
  readonly key: string;
  readonly size: number;
  readonly uploaded: Date;
}

/**
 * Matches one listing page of `folder` against the names still looked for
 * there: each match goes to `existing`, and its name leaves `names`.
 */
export function matchListing(
  folder: string,
  names: Map<string, string[]>,
  objects: readonly ListedObject[],
  existing: ExistingKey[],
): void {
  for (const object of objects) {
    const name = inNfc(object.key.slice(folder.length));
    const asked = names.get(name);
    if (asked === undefined) {
      continue;
    }
    for (const key of asked) {
      existing.push({
        key,
        storedKey: object.key,
        size: object.size,
        uploadedAt: object.uploaded.toISOString(),
      });
    }
    names.delete(name);
  }
}
