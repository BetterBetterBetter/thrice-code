import assert from 'node:assert/strict';
import test from 'node:test';
import { parseThriceChart } from './thriceChart.js';

test('a thrice-chart fence accepts a title and numeric series', () => {
	const parsed = parseThriceChart(JSON.stringify({
		title: 'Requests',
		series: [{ name: 'Mon', value: 3 }, { name: 'Tue', value: 5 }],
	}));
	assert.equal('spec' in parsed, true);
	if ('spec' in parsed) {
		assert.equal(parsed.spec.title, 'Requests');
		assert.deepEqual(parsed.spec.series, [{ name: 'Mon', value: 3 }, { name: 'Tue', value: 5 }]);
	}
});

test('a thrice-chart fence reports an error the chat can show', () => {
	assert.equal('error' in parseThriceChart('not json'), true);
	assert.equal('error' in parseThriceChart(JSON.stringify({ title: 'Requests' })), true);
	assert.equal('error' in parseThriceChart(JSON.stringify({ title: 'Requests', series: [{ name: 'Mon', value: '3' }] })), true);
});
