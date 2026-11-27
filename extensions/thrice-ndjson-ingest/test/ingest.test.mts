import test from 'node:test';
import { same } from '../../_thrice-clone-test/helper.mts';
import {
	CHANGE_PORT,
	DEFAULT_BIND,
	KNOWN_METHODS,
	PORT_IN_USE,
	createIngest,
	handleRequest,
	reassignPort,
	resolveListenPort,
	start,
	stop,
} from '../src/ingest.ts';

test('auto port is the first free port from 7242 through 7942', () => {
	same(resolveListenPort(0, () => false), 7242);
	same(resolveListenPort(0, port => port < 7300), 7300);
});

test('a taken port reports the retained collision strings', () => {
	same(resolveListenPort(0, () => true), { error: PORT_IN_USE, action: CHANGE_PORT });
	same(resolveListenPort(8000, () => true), { error: PORT_IN_USE, action: CHANGE_PORT });
	same(PORT_IN_USE, 'Port is already in use');
	same(CHANGE_PORT, 'Change Port');
});

test('a configured free port is used as given', () => {
	same(resolveListenPort(8000, () => false), 8000);
});

test('start and stop move the server between stopped and listening', () => {
	const stopped = createIngest();
	same(stopped.state, 'stopped');
	const listening = start(stopped, { port: 7242, bindAddress: DEFAULT_BIND });
	same(listening, { state: 'listening', port: 7242, bindAddress: '127.0.0.1' });
	same(stop(listening).state, 'stopped');
});

test('reassign stops the current listener and starts on the new port', () => {
	const listening = start(createIngest(), { port: 7242, bindAddress: DEFAULT_BIND });
	same(reassignPort(listening, 7300), { state: 'listening', port: 7300, bindAddress: '127.0.0.1' });
});

test('known methods are not answered because the path is unconfirmed', () => {
	same(KNOWN_METHODS, ['POST', 'OPTIONS', 'get']);
	same(handleRequest({ method: 'POST' }), { accepted: false, reason: 'path-unknown' });
	same(handleRequest({ method: 'OPTIONS' }), { accepted: false, reason: 'path-unknown' });
	same(handleRequest({ method: 'get' }), { accepted: false, reason: 'path-unknown' });
});
