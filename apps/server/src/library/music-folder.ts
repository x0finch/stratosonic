/**
 * Stratosonic serves one R2 bucket as one library, so there is exactly one
 * music folder and it has this id. Everything that names the folder uses this
 * constant: `getUser`'s `folder` list today, and `getMusicFolders` when the
 * library lands.
 */
export const MUSIC_FOLDER_ID = 1;
