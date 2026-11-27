import test from 'node:test';
import { same } from '../../_thrice-clone-test/helper.mts';
import {
	TRANSIENT_ERROR,
	acquireLease,
	cancelShutdownTimer,
	closeConnectionFromLease,
	createLease,
	injectFailure,
	isClosed,
	releaseLease,
	scheduleShutdownIfUnowned,
	writeFromLease,
} from '../src/lease.ts';

test('a lease is created, acquired, and release closes its connections', () => {
	const created = createLease('tcp');
	same(created.state, 'created');
	same(created.transport, 'tcp');
	const owned = acquireLease(created);
	const withConnection = { ...owned, connections: ['c1'] };
	const released = releaseLease(withConnection);
	same(released.state, 'released');
	same(released.connections, []);
	same(isClosed(released), true);
});

test('an unowned lease can schedule shutdown without a delay, and cancel clears it', () => {
	const created = createLease('tls');
	const scheduled = scheduleShutdownIfUnowned(created);
	same(scheduled.shutdownScheduled, true);
	same('delayMs' in scheduled, false);
	same(cancelShutdownTimer(scheduled).shutdownScheduled, false);
	const owned = acquireLease(created);
	same(scheduleShutdownIfUnowned(owned).shutdownScheduled, false);
});

test('injectFailure names CursorSocketTransient and write requires an open acquired lease', () => {
	const failed = injectFailure(acquireLease(createLease('tcp')));
	same(failed.errorName, TRANSIENT_ERROR);
	same(TRANSIENT_ERROR, 'CursorSocketTransient');
	same(writeFromLease(failed, 'bytes'), { ok: false, reason: 'closed' });
	same(writeFromLease(acquireLease(createLease('tcp')), 'bytes'), { ok: true });
	same(closeConnectionFromLease(acquireLease(createLease('tcp'))).connections, []);
});

test('only tcp and tls are transports', () => {
	same(createLease('udp'), { ok: false, reason: 'unknown-transport' });
});
