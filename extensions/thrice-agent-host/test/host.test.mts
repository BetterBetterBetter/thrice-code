import test from 'node:test';
import { same } from '../../_thrice-clone-test/helper.mts';
import { hostOwnedSessionStorageEnabled, legacyMigrationMode, resolveInferenceRoute, runMigration } from '../src/host.ts';

test('host-owned storage is off unless the setting or the env switch is on', () => {
	same(hostOwnedSessionStorageEnabled(false, undefined), false);
	same(hostOwnedSessionStorageEnabled(true, undefined), true);
	same(hostOwnedSessionStorageEnabled(false, '1'), true);
	same(hostOwnedSessionStorageEnabled(false, 'true'), true);
	same(hostOwnedSessionStorageEnabled(false, '0'), false);
});

test('the legacy migration env overrides the setting when it is dry-run or migrate', () => {
	same(legacyMigrationMode('off', 'dry-run'), 'dry-run');
	same(legacyMigrationMode('migrate', 'migrate'), 'migrate');
	same(legacyMigrationMode('migrate', 'off'), 'migrate');
	same(legacyMigrationMode('dry-run', undefined), 'dry-run');
});

test('off does not run, dry-run writes nothing, and migrate does not write without the tool', () => {
	same(runMigration({ mode: 'off', hostOwned: true, requested: false }), { ran: false, wrote: false });
	same(runMigration({ mode: 'dry-run', hostOwned: true, requested: false }), { ran: true, wrote: false });
	same(runMigration({ mode: 'migrate', hostOwned: true, requested: false }), {
		ran: true,
		wrote: false,
		reason: 'migration-tool-unknown',
	});
	same(runMigration({ mode: 'dry-run', hostOwned: false, requested: false }), {
		ran: false,
		wrote: false,
		reason: 'host-owned-storage-off',
	});
	same(runMigration({ mode: 'off', hostOwned: true, requested: true }), {
		ran: true,
		wrote: false,
		reason: 'migration-tool-unknown',
	});
});

test('auto does not pick a network, and always or never stay the setting', () => {
	same(resolveInferenceRoute('auto'), { route: 'auto', choice: 'unknown' });
	same(resolveInferenceRoute('always'), { route: 'always', choice: 'setting' });
	same(resolveInferenceRoute('never'), { route: 'never', choice: 'setting' });
});
