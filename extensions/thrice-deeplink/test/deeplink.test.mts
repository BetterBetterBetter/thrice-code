import test from 'node:test';
import { same } from '../../_thrice-clone-test/helper.mts';
import { triggerDeeplink } from '../src/deeplink.ts';

test('a deeplink is not parsed while the URI grammar is unconfirmed', () => {
	same(triggerDeeplink('thrice://plugin/data'), {
		ok: false,
		reason: 'uri-grammar-unconfirmed',
	});
	same(triggerDeeplink('cursor://anything'), {
		ok: false,
		reason: 'uri-grammar-unconfirmed',
	});
});
