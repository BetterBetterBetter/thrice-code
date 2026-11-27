#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Writes the JSON asset the desktop updater downloads from GitHub releases.
//
// product.json updateUrl is https://github.com/<owner>/<repo>/releases.
// The app requests releases/latest/download/<platform>.json and compares
// `version` with its own commit. Upload this file next to the build asset
// on every release. Platform names match the updater:
//   darwin, darwin-arm64, win32-x64, win32-arm64, win32-x64-user,
//   win32-arm64-user, linux-x64, linux-arm64, linux-armhf
// Insider builds use <quality>-<platform>.json.

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const [platform, tag, commit, productVersion, assetName, publishedAt] = process.argv.slice(2);
if (!platform || !tag || !commit || !productVersion || !assetName || !publishedAt) {
	console.error('usage: write-release-feed.mjs <platform> <tag> <commit> <productVersion> <assetName> <publishedAt>');
	process.exit(1);
}
if (!/^[0-9a-f]{40}$/i.test(commit)) {
	console.error(`commit must be a 40-character SHA, got '${commit}'`);
	process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const product = JSON.parse(readFileSync(join(root, 'product.json'), 'utf8'));
const match = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/releases\/?$/i.exec(product.updateUrl ?? '');
if (!match) {
	console.error(`product.json updateUrl is not a GitHub releases page: ${product.updateUrl}`);
	process.exit(1);
}

const feed = {
	url: `https://github.com/${match[1]}/${match[2]}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`,
	name: productVersion,
	notes: `Thrice Code ${productVersion}`,
	pub_date: publishedAt,
	version: commit,
	productVersion,
};

const file = `${platform}.json`;
writeFileSync(file, JSON.stringify(feed, null, '\t') + '\n');
console.log(`wrote ${file}`);
