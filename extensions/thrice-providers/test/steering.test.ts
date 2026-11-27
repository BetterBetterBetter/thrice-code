import assert from "node:assert/strict";
import test from "node:test";
import { watchYield } from "../src/steering.ts";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("yields once when the flag is set during the turn", async () => {
	let requested = false;
	let calls = 0;
	const watch = watchYield(
		() => requested,
		() => calls++,
		5,
	);
	await tick(20);
	assert.equal(calls, 0);
	assert.equal(watch.yielded, false);
	requested = true;
	await tick(20);
	assert.equal(calls, 1);
	assert.equal(watch.yielded, true);
	await tick(20);
	assert.equal(calls, 1);
	watch.dispose();
});

test("yields immediately when the flag was set before the turn started", () => {
	let calls = 0;
	const watch = watchYield(
		() => true,
		() => calls++,
		1000,
	);
	assert.equal(calls, 1);
	assert.equal(watch.yielded, true);
	watch.dispose();
});

test("stops polling after dispose", async () => {
	let requested = false;
	let calls = 0;
	const watch = watchYield(
		() => requested,
		() => calls++,
		5,
	);
	watch.dispose();
	requested = true;
	await tick(20);
	assert.equal(calls, 0);
});
