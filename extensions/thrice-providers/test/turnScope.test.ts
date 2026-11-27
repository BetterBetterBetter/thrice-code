import assert from "node:assert/strict";
import test from "node:test";
import { TurnScopes } from "../src/turnScope.ts";

test("a turn running alone keeps files its agent did not report", () => {
	const scopes = new TurnScopes();
	const turn = scopes.begin("/repo/");
	turn.report("/repo/a.ts");
	assert.equal(turn.attribute("/repo/a.ts"), "reported");
	assert.equal(turn.attribute("/repo/generated.ts"), "unreported");
});

test("overlapping turns keep only what they reported, and not each other's files", () => {
	const scopes = new TurnScopes();
	const a = scopes.begin("/repo");
	const b = scopes.begin("/repo");
	a.report("/repo/a.ts");
	b.report("/repo/b.ts");
	assert.equal(a.attribute("/repo/a.ts"), "reported");
	assert.equal(a.attribute("/repo/b.ts"), "otherTurn");
	assert.equal(b.attribute("/repo/a.ts"), "otherTurn");
	assert.equal(a.attribute("/repo/sed-edited.ts"), "concurrent");
	// Both agents edited it: each keeps it.
	b.report("/repo/a.ts");
	assert.equal(b.attribute("/repo/a.ts"), "reported");
});

test("a turn that started and ended inside another still marks the longer one as overlapped", () => {
	const scopes = new TurnScopes();
	const long = scopes.begin("/repo");
	const short = scopes.begin("/repo");
	short.report("/repo/s.ts");
	short.end();
	assert.equal(scopes.running("/repo"), 1);
	assert.equal(long.attribute("/repo/s.ts"), "otherTurn");
	assert.equal(long.attribute("/repo/x.ts"), "concurrent");
	// A turn starting after both ended runs alone.
	long.end();
	assert.equal(scopes.begin("/repo").attribute("/repo/x.ts"), "unreported");
});

test("turns in different repos do not affect each other", () => {
	const scopes = new TurnScopes();
	const a = scopes.begin("/repo");
	const b = scopes.begin("/repo-other");
	b.report("/repo-other/b.ts");
	scopes.saved("/repo-other/c.ts");
	assert.equal(a.attribute("/repo/x.ts"), "unreported");
	assert.equal(b.attribute("/repo-other/c.ts"), "userSaved");
	assert.equal(a.attribute("/repo-other/b.ts"), "unreported");
});

test("files the user saves during a turn are theirs unless the agent reported them", () => {
	const scopes = new TurnScopes();
	const turn = scopes.begin("/repo");
	scopes.saved("/repo/mine.ts");
	scopes.saved("/repo/both.ts");
	turn.report("/repo/both.ts");
	assert.equal(turn.attribute("/repo/mine.ts"), "userSaved");
	assert.equal(turn.attribute("/repo/both.ts"), "reported");
	turn.end();
	scopes.saved("/repo/later.ts");
	assert.equal(turn.attribute("/repo/later.ts"), "unreported");
});
