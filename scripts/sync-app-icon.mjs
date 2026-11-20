import { readFile, writeFile } from 'node:fs/promises';

const source = new URL('../assets/brand/avatar.png', import.meta.url);
const target = new URL('../ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', import.meta.url);
const image = await readFile(source);
const invalid = () => { throw new Error('avatar.png 必须是 1024×1024、无透明通道的 RGB PNG；请替换源文件。'); };
if (image.length < 33 || image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') invalid();
if (image.readUInt32BE(16) !== 1024 || image.readUInt32BE(20) !== 1024 || image[25] !== 2) invalid();
for (let offset = 8; offset + 12 <= image.length;) {
  const length = image.readUInt32BE(offset);
  if (offset + length + 12 > image.length) invalid();
  if (image.toString('ascii', offset + 4, offset + 8) === 'tRNS') invalid();
  offset += length + 12;
}
const previous = await readFile(target).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});
if (!previous?.equals(image)) await writeFile(target, image);
console.log('App icon synced from assets/brand/avatar.png (runtime asset, not bundled)');
