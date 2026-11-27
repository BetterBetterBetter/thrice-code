import assert from 'node:assert/strict';

export function same(actual: unknown, expected: unknown): void {
	assert.deepEqual(actual, expected);
}
