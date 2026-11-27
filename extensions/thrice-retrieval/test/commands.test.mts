import test from 'node:test';
import { readFileSync } from 'node:fs';
import { same } from '../../_thrice-clone-test/helper.mts';
import { developerCommand } from '../src/commands.ts';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('developer commands do not send a snapshot or a report', () => {
	same(developerCommand('debug'), { ok: false, reason: 'payload-unknown' });
	same(developerCommand('snapshot'), { ok: false, reason: 'payload-unknown' });
	same(developerCommand('report'), { ok: false, reason: 'disabled' });
});

test('palette gates match the confirmed when clauses', () => {
	const palette = manifest.contributes.menus.commandPalette;
	same(palette, [
		{ command: 'thrice.retrieval.grepClient.debug', when: 'isDevelopment' },
		{ command: 'thrice.retrieval.codebaseTelemetry.triggerSnapshot', when: 'isDevelopment' },
		{ command: 'thrice.retrieval.codebaseTelemetry.reportComposerRequest', when: 'false' },
	]);
	same(manifest.contributes.configuration.properties['thrice.retrieval.canAttemptGithubLogin'], {
		type: 'boolean',
		default: true,
		scope: 'resource',
		description: 'Whether retrieval may attempt a GitHub login. The login call itself is unconfirmed.',
	});
	same(manifest.contributes.languages.map((language: { filenames: string[] }) => language.filenames[0]), [
		'.cursorignore',
		'.cursorindexingignore',
	]);
});
