import { unlink } from 'node:fs/promises';

// Compatibility entry point for older build hooks. Runtime lyrics belong to
// persisted queue entries, not the app bundle. Remove only our obsolete output;
// unlink deliberately refuses directories and never follows a file symlink.
try {
  await unlink(new URL('../static/native-lyrics.json', import.meta.url));
  console.log('Removed obsolete generated native lyric catalog.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.log('No obsolete generated native lyric catalog to remove.');
}
