import assert from "node:assert/strict";
import test from "node:test";
import {
	agentTools,
	AgentRuns,
	childPrompt,
	formatAgentList,
	formatRun,
	MAX_WAIT_MS,
	waitMs,
	type AgentLaunchHandle,
	type AgentRunSink,
	type AgentRunSpec,
} from "../src/agents.ts";

const spec: AgentRunSpec = {
	agent: "codex-hub",
	displayName: "Codex Hub",
	model: "gpt",
	mode: "background",
	prompt: "audit",
	owner: "launch-a",
	depth: 1,
	resumable: false,
};

function controlled(): {
	launch: (sink: AgentRunSink) => AgentLaunchHandle;
	sink: () => AgentRunSink;
	finish: () => void;
	fail: (error: Error) => void;
	stopped: () => boolean;
} {
	let sink: AgentRunSink | undefined;
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	let stopped = false;
	const done = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return {
		launch: (s) => {
			sink = s;
			return {
				done,
				stop: () => {
					stopped = true;
					reject(new Error("cancelled"));
				},
			};
		},
		sink: () => sink!,
		finish: () => resolve(),
		fail: (error) => reject(error),
		stopped: () => stopped,
	};
}

test("a run collects text and finishes", async () => {
	const runs = new AgentRuns();
	const c = controlled();
	const run = runs.start(spec, c.launch);
	assert.equal(run.status, "running");
	assert.equal(runs.running(), 1);
	c.sink().activity("Reading a.ts");
	c.sink().text("found ");
	c.sink().text("nothing");
	const early = await runs.wait(run.id, 10);
	assert.equal(early?.status, "running");
	assert.match(formatRun(run), /Still running: call waitAgent with id agent-1/);
	assert.match(formatRun(run), /Last activity: Reading a\.ts/);
	c.finish();
	const finished = await runs.wait(run.id, 1000);
	assert.equal(finished?.status, "done");
	assert.equal(runs.running(), 0);
	assert.match(
		formatRun(run),
		/done after \d+s, 1 tool calls\.\n\nfound nothing$/,
	);
});

test("a failed run reports its error, and a stopped run is cancelled", async () => {
	const runs = new AgentRuns();
	const failing = controlled();
	const failed = runs.start(spec, failing.launch);
	failing.fail(new Error("Codex Hub needs AGENTCLI_KEY"));
	await runs.wait(failed.id, 1000);
	assert.equal(failed.status, "failed");
	assert.match(formatRun(failed), /Error: Codex Hub needs AGENTCLI_KEY/);

	const stopping = controlled();
	const stopped = runs.start(spec, stopping.launch);
	assert.equal(runs.stop(stopped.id), true);
	assert.equal(stopping.stopped(), true);
	await runs.wait(stopped.id, 1000);
	assert.equal(stopped.status, "cancelled");
	assert.equal(stopped.error, undefined);
	assert.equal(runs.stop(stopped.id), false);
});

test("a launcher that throws gives a failed run", () => {
	const runs = new AgentRuns();
	const run = runs.start(spec, () => {
		throw new Error("spawn ENOENT");
	});
	assert.equal(run.status, "failed");
	assert.equal(run.error, "spawn ENOENT");
	assert.equal(runs.running(), 0);
});

test("releasing a launch stops its runs and leaves other launches alone", async () => {
	const runs = new AgentRuns();
	const mine = controlled();
	const other = controlled();
	const a = runs.start(spec, mine.launch);
	const b = runs.start({ ...spec, owner: "launch-b" }, other.launch);
	assert.deepEqual(
		runs.ownedBy("launch-a").map((run) => run.id),
		[a.id],
	);
	runs.release("launch-a");
	assert.equal(mine.stopped(), true);
	assert.equal(other.stopped(), false);
	assert.equal(runs.get(a.id), undefined);
	assert.equal(runs.get(b.id)?.status, "running");
});

test("a cancelled wait returns at once", async () => {
	const runs = new AgentRuns();
	const c = controlled();
	const run = runs.start(spec, c.launch);
	let listener: (() => void) | undefined;
	const waiting = runs.wait(run.id, 60000, {
		isCancellationRequested: false,
		onCancellationRequested: (l) => {
			listener = l;
			return { dispose: () => undefined };
		},
	});
	listener?.();
	assert.equal((await waiting)?.status, "running");
	c.finish();
});

test("wait times are clamped", () => {
	assert.equal(waitMs(undefined, 5), 5);
	assert.equal(waitMs(-1, 5), 0);
	assert.equal(waitMs(Number.POSITIVE_INFINITY, 5), 5);
	assert.equal(waitMs(10 * MAX_WAIT_MS, 5), MAX_WAIT_MS);
});

test("the listing shows providers, readiness, the caller and the depth limit", () => {
	const runs = new AgentRuns();
	const run = runs.start(spec, controlled().launch);
	const agents = [
		{
			id: "claude-hub",
			displayName: "Claude Hub",
			driver: "claude",
			models: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }],
			missing: [],
		},
		{
			id: "codex-hub",
			displayName: "Codex Hub",
			driver: "codex",
			models: [{ id: "gpt-6.1-sol", name: "gpt-6.1-sol" }],
			missing: ["AGENTCLI_KEY"],
		},
	];
	const text = formatAgentList(agents, {
		self: { agent: "claude-hub", model: "claude-opus-5-5" },
		depth: 0,
		maxDepth: 1,
		running: 1,
		maxRunning: 4,
		runs: [run],
	});
	assert.match(
		text,
		/- claude-hub: Claude Hub \(you, claude-opus-5-5\), claude CLI, ready\./,
	);
	assert.match(text, /models: claude-opus-5-5 \(Claude Opus 5\.5\)/);
	assert.match(
		text,
		/- codex-hub: Codex Hub, codex CLI, cannot start: needs AGENTCLI_KEY\./,
	);
	assert.match(text, /models: gpt-6\.1-sol$/m);
	assert.match(
		text,
		/You can start agents with runAgent\. You are at depth 0 of 1; 1 of 4/,
	);
	assert.match(
		text,
		/Agents you started:\n- agent-1: Codex Hub \(gpt\), running/,
	);
	const limited = formatAgentList(agents, {
		depth: 1,
		maxDepth: 1,
		running: 0,
		maxRunning: 4,
		runs: [],
	});
	assert.match(
		limited,
		/You cannot start agents: you are at depth 1 and the limit is 1/,
	);
});

test("only a launch below the depth limit gets the run tools", () => {
	assert.deepEqual(
		agentTools(true).map((tool) => tool.name),
		["listAgents", "runAgent", "waitAgent", "sendAgent", "stopAgent"],
	);
	assert.deepEqual(
		agentTools(false).map((tool) => tool.name),
		["listAgents"],
	);
});

test("a child prompt says who started it and that nobody will answer", () => {
	const text = childPrompt("Audit the diff.", {
		displayName: "Claude Hub",
		depth: 0,
	});
	assert.match(text, /started by another agent \(Claude Hub\).*depth 1/);
	assert.match(text, /Nobody will answer questions/);
	assert.ok(text.endsWith("Audit the diff."));
});

test("the parent chat labels runAgent as an agent run", async () => {
	const { describeTool, formatLabel } = await import("../src/events.ts");
	const description = describeTool("mcp__thrice__runAgent", {
		agent: "codex-hub",
		prompt: "Audit the diff",
	});
	assert.equal(description.kind, "agent");
	assert.match(
		formatLabel(description),
		/^Running agent `codex-hub` Audit the diff$/,
	);
});

test("a read-only parent only starts read-only children", async () => {
	const { childMode } = await import("../src/agents.ts");
	assert.deepEqual(childMode("interactive", undefined), {
		mode: "background",
		forced: false,
	});
	assert.deepEqual(childMode("interactive", "nonsense"), {
		mode: "background",
		forced: false,
	});
	assert.deepEqual(childMode(undefined, "debug"), {
		mode: "debug",
		forced: false,
	});
	assert.deepEqual(childMode("ask", "background"), {
		mode: "ask",
		forced: true,
	});
	assert.deepEqual(childMode("plan", "interactive"), {
		mode: "plan",
		forced: true,
	});
	assert.deepEqual(childMode("ask", "triage"), {
		mode: "triage",
		forced: false,
	});
});

test("opencode names runAgent thrice_runAgent and gets the same label", async () => {
	const { describeTool, formatLabel, isRunAgentTool } =
		await import("../src/events.ts");
	assert.equal(isRunAgentTool("thrice_runAgent"), true);
	assert.equal(isRunAgentTool("mcp__thrice__runAgent"), true);
	assert.equal(isRunAgentTool("mcp__thrice__waitAgent"), false);
	assert.match(
		formatLabel(
			describeTool("thrice_runAgent", {
				agent: "claude-hub",
				prompt: "Review",
			}),
		),
		/^Running agent `claude-hub` Review$/,
	);
});

test("a follow-up continues the same run, and a late result from the first turn is ignored", async () => {
	const runs = new AgentRuns();
	const first = controlled();
	const run = runs.start({ ...spec, resumable: true }, first.launch);
	first.sink().text("first answer");
	first.finish();
	await runs.wait(run.id, 1000);
	assert.equal(run.status, "done");
	assert.match(
		formatRun(run),
		/To follow up, call sendAgent with id agent-1\./,
	);
	const second = controlled();
	assert.equal(runs.resume(run.id, second.launch), true);
	assert.equal(run.status, "running");
	assert.equal(run.turns, 2);
	assert.equal(run.text, "");
	assert.equal(runs.resume(run.id, controlled().launch), false);
	second.sink().text("second answer");
	second.finish();
	await runs.wait(run.id, 1000);
	assert.match(
		formatRun(run),
		/^Run agent-1 \(turn 2\): Codex Hub \(gpt\), done/,
	);
	assert.match(formatRun(run), /second answer/);
	assert.doesNotMatch(formatRun(run), /first answer/);
});

test("a run without a session cannot be followed up, and release reports what it let go", async () => {
	const runs = new AgentRuns();
	const c = controlled();
	const run = runs.start({ ...spec, resumable: false }, c.launch);
	c.finish();
	await runs.wait(run.id, 1000);
	assert.equal(runs.resume(run.id, controlled().launch), false);
	assert.doesNotMatch(formatRun(run), /sendAgent/);
	const live = runs.start({ ...spec, resumable: true }, controlled().launch);
	runs.start(
		{ ...spec, owner: "launch-b", resumable: true },
		controlled().launch,
	);
	assert.deepEqual(runs.release("launch-a").sort(), [run.id, live.id].sort());
});

test("a follow-up prompt carries the original task only when the session was lost", async () => {
	const { followUpPrompt } = await import("../src/agents.ts");
	const kept = followUpPrompt(
		"Now check the tests.",
		"Audit the diff.",
		{ displayName: "Claude Hub", depth: 0 },
		false,
	);
	assert.match(
		kept,
		/^Follow-up from the agent that started you \(Claude Hub\)/,
	);
	assert.doesNotMatch(kept, /Audit the diff/);
	const fresh = followUpPrompt(
		"Now check the tests.",
		"Audit the diff.",
		{ displayName: "Claude Hub", depth: 0 },
		true,
	);
	assert.match(
		fresh,
		/Audit the diff\.\n\nFollow-up from .*\n\nNow check the tests\.$/s,
	);
});

test("sendAgent is offered with the run tools and labelled in the parent chat", async () => {
	assert.ok(agentTools(true).some((tool) => tool.name === "sendAgent"));
	const { describeTool, formatLabel, isRunAgentTool } =
		await import("../src/events.ts");
	assert.equal(isRunAgentTool("mcp__thrice__sendAgent"), true);
	assert.equal(isRunAgentTool("thrice_sendAgent"), true);
	assert.match(
		formatLabel(
			describeTool("mcp__thrice__sendAgent", {
				id: "agent-1",
				prompt: "Check tests",
			}),
		),
		/^Following up with agent `agent-1` Check tests$/,
	);
});

test("the launcher learns the run id before start returns", () => {
	const runs = new AgentRuns();
	let seen = "";
	const run = runs.start(spec, (sink) => {
		seen = sink.runId;
		return { done: new Promise<void>(() => {}), stop: () => {} };
	});
	assert.equal(seen, run.id);
	assert.notEqual(seen, "");
});
