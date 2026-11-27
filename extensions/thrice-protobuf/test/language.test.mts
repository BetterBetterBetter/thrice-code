import test from 'node:test';
import { readFileSync } from 'node:fs';
import { same } from '../../_thrice-clone-test/helper.mts';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const config = JSON.parse(readFileSync(new URL('language-configuration.json', root), 'utf8'));

test('protobuf contributes the language, the source scope, and the markdown injection', () => {
	same(manifest.contributes.languages[0].id, 'protobuf');
	same(manifest.contributes.languages[0].extensions, ['.proto']);
	same(manifest.contributes.grammars.map((grammar: { scopeName: string }) => grammar.scopeName), [
		'source.proto',
		'markdown.protobuf.codeblock',
	]);
	same(config.comments, undefined);
	same(config.brackets, undefined);
	same(config.autoClosingPairs, undefined);
});
