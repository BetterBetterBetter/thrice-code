import test from 'node:test';
import { same } from '../../_thrice-clone-test/helper.mts';
import { callTool, handleUri, prepareAuthorization } from '../src/mcp.ts';

test('authorization, tool calls, and URI handling stay unconfirmed', () => {
	same(prepareAuthorization(), { ok: false, reason: 'redirect-unconfirmed' });
	same(callTool(), { ok: false, reason: 'arguments-unknown' });
	same(handleUri('thrice://mcp'), { ok: false, reason: 'uri-grammar-unconfirmed' });
});
