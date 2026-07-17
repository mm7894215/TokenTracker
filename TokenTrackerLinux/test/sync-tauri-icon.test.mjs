import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import {
  canonicalIconPath,
  createRgbaPng,
  syncTauriIcon,
} from '../scripts/sync-tauri-icon.mjs';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function pngHeader(buffer) {
  assert.deepEqual(buffer.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
  };
}

test('canonical dashboard icon converts to an 8-bit RGBA PNG', () => {
  const canonical = fs.readFileSync(canonicalIconPath);
  assert.equal(pngHeader(canonical).colorType, 3, 'fixture verifies the canonical icon is palette PNG');

  const converted = createRgbaPng(canonical);
  assert.deepEqual(pngHeader(converted), {
    width: 512,
    height: 512,
    bitDepth: 8,
    colorType: 6,
  });

  const decoded = PNG.sync.read(converted);
  const canonicalPixels = PNG.sync.read(canonical);
  assert.equal(decoded.width, 512);
  assert.equal(decoded.height, 512);
  assert.equal(
    sha256(decoded.data),
    sha256(canonicalPixels.data),
    'RGBA conversion must preserve the canonical icon pixels',
  );
});

test('sync writes a deterministic RGBA Tauri icon', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokentracker-icon-'));
  const destination = path.join(temporaryDirectory, 'icons', 'icon.png');

  try {
    syncTauriIcon(canonicalIconPath, destination);
    const first = fs.readFileSync(destination);
    syncTauriIcon(canonicalIconPath, destination);
    const second = fs.readFileSync(destination);

    assert.deepEqual(first, second);
    assert.equal(pngHeader(first).colorType, 6);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
