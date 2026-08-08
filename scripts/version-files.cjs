const fs = require('fs');
const path = require('path');

const VERSION_FILES = [
  {
    label: 'package.json',
    read(content) { return JSON.parse(content).version; },
    write(content, version) {
      const json = JSON.parse(content);
      json.version = version;
      return `${JSON.stringify(json, null, 2)}\n`;
    },
  },
  {
    label: 'TokenTrackerBar/project.yml',
    read(content) {
      const matches = [...content.matchAll(/^\s*MARKETING_VERSION:\s*["']([^"']+)["']\s*$/gm)];
      if (matches.length !== 2) throw new Error('Expected exactly two MARKETING_VERSION entries in TokenTrackerBar/project.yml');
      if (matches[0][1] !== matches[1][1]) throw new Error('MARKETING_VERSION entries in TokenTrackerBar/project.yml must match');
      return matches[0][1];
    },
    write(content, version) {
      let count = 0;
      const updated = content.replace(/^(\s*MARKETING_VERSION:\s*["'])[^"']+(["']\s*)$/gm, (_, start, end) => {
        count += 1;
        return `${start}${version}${end}`;
      });
      if (count !== 2) throw new Error('Expected exactly two MARKETING_VERSION entries in TokenTrackerBar/project.yml');
      return updated;
    },
  },
  {
    label: 'TokenTrackerWin/TokenTrackerWin.csproj',
    read(content) {
      const matches = [...content.matchAll(/<Version>([^<]+)<\/Version>/g)];
      if (matches.length !== 1) throw new Error('Expected exactly one <Version> entry in TokenTrackerWin/TokenTrackerWin.csproj');
      return matches[0][1];
    },
    write(content, version) { return replaceExactlyOne(content, /(<Version>)[^<]+(<\/Version>)/g, `$1${version}$2`, 'TokenTrackerWin/TokenTrackerWin.csproj <Version>'); },
  },
  {
    label: 'TokenTrackerLinux/package.json',
    read(content) { return JSON.parse(content).version; },
    write(content, version) {
      const json = JSON.parse(content);
      json.version = version;
      return `${JSON.stringify(json, null, 2)}\n`;
    },
  },
  {
    label: 'TokenTrackerLinux/package-lock.json',
    read(content) {
      const json = JSON.parse(content);
      if (!json.version || !json.packages || !json.packages[''] || !json.packages[''].version) throw new Error('Missing root package version in TokenTrackerLinux/package-lock.json');
      if (json.version !== json.packages[''].version) throw new Error('Root version entries in TokenTrackerLinux/package-lock.json must match');
      return json.version;
    },
    write(content, version) {
      const json = JSON.parse(content);
      if (!json.packages || !json.packages['']) throw new Error('Missing root package entry in TokenTrackerLinux/package-lock.json');
      json.version = version;
      json.packages[''].version = version;
      return `${JSON.stringify(json, null, 2)}\n`;
    },
  },
  {
    label: 'TokenTrackerLinux/src-tauri/Cargo.toml',
    read(content) { return readCargoPackageVersion(content, 'TokenTrackerLinux/src-tauri/Cargo.toml'); },
    write(content, version) { return writeCargoPackageVersion(content, version, 'TokenTrackerLinux/src-tauri/Cargo.toml'); },
  },
  {
    label: 'TokenTrackerLinux/src-tauri/Cargo.lock',
    read(content) { return readCargoLockPackageVersion(content); },
    write(content, version) { return writeCargoLockPackageVersion(content, version); },
  },
  {
    label: 'TokenTrackerLinux/src-tauri/tauri.conf.json',
    read(content) { return JSON.parse(content).version; },
    write(content, version) {
      const json = JSON.parse(content);
      json.version = version;
      return `${JSON.stringify(json, null, 2)}\n`;
    },
  },
  {
    label: 'TokenTrackerLinux/packaging/arch/tokentracker-linux/PKGBUILD',
    read(content) {
      const matches = [...content.matchAll(/^pkgver=([^\s#]+)\s*$/gm)];
      if (matches.length !== 1) throw new Error('Expected exactly one pkgver entry in TokenTrackerLinux/packaging/arch/tokentracker-linux/PKGBUILD');
      return matches[0][1];
    },
    write(content, version) { return replaceExactlyOne(content, /^(pkgver=)[^\s#]+\s*$/gm, `$1${version}`, 'PKGBUILD pkgver'); },
  },
];

function readFile(root, label) {
  return fs.readFileSync(path.join(root, label), 'utf8');
}

function replaceExactlyOne(content, pattern, replacement, description) {
  const matches = [...content.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Expected exactly one ${description} entry`);
  return content.replace(pattern, replacement);
}

function packageSection(content, label) {
  const header = /^\[package\]\s*$/m.exec(content);
  if (!header) throw new Error(`Missing [package] section in ${label}`);
  const nextSection = /^\[/gm;
  nextSection.lastIndex = header.index + header[0].length;
  const next = nextSection.exec(content);
  return { start: header.index, end: next ? next.index : content.length };
}

function readCargoPackageVersion(content, label) {
  const { start, end } = packageSection(content, label);
  const section = content.slice(start, end);
  const matches = [...section.matchAll(/^version\s*=\s*"([^"]+)"\s*$/gm)];
  if (matches.length !== 1) throw new Error(`Expected exactly one package version in ${label}`);
  return matches[0][1];
}

function writeCargoPackageVersion(content, version, label) {
  const { start, end } = packageSection(content, label);
  const section = content.slice(start, end);
  const updated = replaceExactlyOne(section, /^(version\s*=\s*")[^"]+("\s*)$/gm, `$1${version}$2`, `${label} package version`);
  return `${content.slice(0, start)}${updated}${content.slice(end)}`;
}

function cargoLockStanza(content) {
  const stanzas = content.split(/(?=^\[\[package\]\]\s*$)/m);
  const matching = stanzas.filter((stanza) => /^\[\[package\]\]\s*$\nname\s*=\s*"tokentracker-linux"\s*$/m.test(stanza));
  if (matching.length !== 1) throw new Error('Expected exactly one tokentracker-linux package stanza in TokenTrackerLinux/src-tauri/Cargo.lock');
  return { stanza: matching[0], start: content.indexOf(matching[0]) };
}

function readCargoLockPackageVersion(content) {
  const { stanza } = cargoLockStanza(content);
  const matches = [...stanza.matchAll(/^version\s*=\s*"([^"]+)"\s*$/gm)];
  if (matches.length !== 1) throw new Error('Expected exactly one tokentracker-linux Cargo.lock version entry');
  return matches[0][1];
}

function writeCargoLockPackageVersion(content, version) {
  const { stanza, start } = cargoLockStanza(content);
  const updated = replaceExactlyOne(stanza, /^(version\s*=\s*")[^"]+("\s*)$/gm, `$1${version}$2`, 'tokentracker-linux Cargo.lock version');
  return `${content.slice(0, start)}${updated}${content.slice(start + stanza.length)}`;
}

function readCanonicalVersion(root) {
  const version = VERSION_FILES[0].read(readFile(root, VERSION_FILES[0].label));
  if (typeof version !== 'string' || version.length === 0) throw new Error('Root package.json must contain a version');
  return version;
}

function collectVersionEntries(root) {
  return VERSION_FILES.map(({ label, read }) => ({ label, version: read(readFile(root, label)) }));
}

function syncVersions(root, version) {
  if (typeof version !== 'string' || version.length === 0) throw new Error('Version must be a non-empty string');
  const changed = [];
  for (const file of VERSION_FILES.slice(1)) {
    const filename = path.join(root, file.label);
    const content = fs.readFileSync(filename, 'utf8');
    const updated = file.write(content, version);
    if (updated !== content) {
      fs.writeFileSync(filename, updated, 'utf8');
      changed.push(file.label);
    }
  }
  return changed;
}

function findVersionMismatches(root, version) {
  return collectVersionEntries(root)
    .filter((entry) => entry.version !== version)
    .map(({ label, version: actual }) => ({ label, expected: version, actual }));
}

module.exports = { readCanonicalVersion, collectVersionEntries, syncVersions, findVersionMismatches };
