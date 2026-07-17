#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const linuxDir = path.resolve(scriptDir, '..');
export const repositoryRoot = path.resolve(linuxDir, '..');
export const canonicalIconPath = path.join(repositoryRoot, 'dashboard', 'public', 'icon-512.png');
export const tauriIconPath = path.join(linuxDir, 'src-tauri', 'icons', 'icon.png');

/** Decode the canonical PNG and encode its pixels as an 8-bit RGBA PNG for Tauri. */
export function createRgbaPng(source) {
  const decoded = PNG.sync.read(source);
  return PNG.sync.write(new PNG({
    width: decoded.width,
    height: decoded.height,
    data: Buffer.from(decoded.data),
  }), { colorType: 6, inputHasAlpha: true });
}

export function syncTauriIcon(sourcePath = canonicalIconPath, destinationPath = tauriIconPath) {
  const rgbaPng = createRgbaPng(fs.readFileSync(sourcePath));
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

  if (!fs.existsSync(destinationPath) || !fs.readFileSync(destinationPath).equals(rgbaPng)) {
    fs.writeFileSync(destinationPath, rgbaPng);
  }

  return destinationPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourcePath = process.argv[2] || canonicalIconPath;
  const destinationPath = process.argv[3] || tauriIconPath;
  console.log(`Synced RGBA Tauri icon: ${syncTauriIcon(sourcePath, destinationPath)}`);
}
