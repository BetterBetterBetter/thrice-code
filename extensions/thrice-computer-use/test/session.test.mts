import test from 'node:test';
import { same } from '../../_thrice-clone-test/helper.mts';
import { callTool, openSession, screenshot } from '../src/session.ts';

test('a session can be open, and tool calls and screenshots stay unanswered', () => {
	const session = openSession();
	same(session, { state: 'open' });
	same(callTool(session), { ok: false, reason: 'arguments-unknown' });
	same(screenshot(), { ok: false, reason: 'image-unknown' });
});
