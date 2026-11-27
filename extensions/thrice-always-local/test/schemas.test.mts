import test from 'node:test';
import { readFileSync } from 'node:fs';
import { same } from '../../_thrice-clone-test/helper.mts';
import { entryAllowed, validatePermissions } from '../src/permissions.ts';

const permissions = JSON.parse(readFileSync(new URL('../schemas/permissions.schema.json', import.meta.url), 'utf8'));
const environment = JSON.parse(readFileSync(new URL('../schemas/environment.schema.json', import.meta.url), 'utf8'));

test('permissions schema names the confirmed properties and refuses unknown ones', () => {
	same(permissions.unevaluatedProperties, false);
	same(permissions.allowComments, true);
	same(permissions.allowTrailingCommas, true);
	same(permissions.required, undefined);
	same(Object.keys(permissions.properties).sort(), [
		'approvalMode',
		'autoReview',
		'autoRun',
		'mcpAllowlist',
		'terminalAllowlist',
	]);
	same(permissions.properties.approvalMode.enum, ['allowlist', 'unrestricted', 'manual']);
});

test('allowlist entries are the four confirmed forms', () => {
	same(entryAllowed('server:tool'), true);
	same(entryAllowed('server:*'), true);
	same(entryAllowed('*:tool'), true);
	same(entryAllowed('*:*'), true);
	same(entryAllowed('nocolon'), false);
});

test('manual approval is accepted and an unknown property is refused', () => {
	same(validatePermissions({ approvalMode: 'manual', mcpAllowlist: ['*:*'] }).ok, true);
	same(validatePermissions({ extra: true }).ok, false);
	same(validatePermissions({ approvalMode: 'ask' }).ok, false);
});

test('environment schema lists both groups and does not invent a required combination', () => {
	same(environment.required, undefined);
	same(environment.unevaluatedProperties, false);
	same(environment.allOf, undefined);
	const names = Object.keys(environment.properties);
	for (const key of [
		'name', 'user', 'install', 'start', 'repositoryDependencies', 'disableAllMcpServers',
		'mcpServerAllowlist', 'egressAllowlist', 'egressMode', 'chromeExecutablePath',
		'enable_testing', 'ports', 'terminals', 'build', 'image', 'snapshot', 'agentCanUpdateSnapshot',
	]) {
		same(names.includes(key), true);
	}
});
