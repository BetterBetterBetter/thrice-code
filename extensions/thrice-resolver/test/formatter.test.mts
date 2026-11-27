import test from 'node:test';
import { readFileSync } from 'node:fs';
import { same } from '../../_thrice-clone-test/helper.mts';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the remote label formatter is the confirmed manifest row', () => {
	same(manifest.contributes.resourceLabelFormatters, [
		{
			scheme: 'vscode-remote',
			authority: 'background-composer+*',
			formatting: {
				label: '${path}',
				separator: '/',
				tildify: true,
				workspaceSuffix: 'cloud-agent',
			},
		},
	]);
	same(manifest.contributes.commands, undefined);
});
