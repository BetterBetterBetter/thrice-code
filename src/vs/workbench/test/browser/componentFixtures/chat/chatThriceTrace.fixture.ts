/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MarkdownString } from "../../../../../base/common/htmlContent.js";
import {
	ChatProgressAnimation,
	ChatProgressVerbosity,
} from "../../../../contrib/chat/common/constants.js";
import {
	IChatSubagentToolInvocationData,
	IChatTerminalToolInvocationData,
	IChatThriceFileEditData,
} from "../../../../contrib/chat/common/chatService/chatService.js";
import { ChatToolInvocation } from "../../../../contrib/chat/common/model/chatProgressTypes/chatToolInvocation.js";
import { ToolDataSource } from "../../../../contrib/chat/common/tools/languageModelToolsService.js";
import {
	ComponentFixtureContext,
	defineComponentFixture,
	defineThemedFixtureGroup,
	waitForFixtureCondition,
} from "../fixtureUtils.js";
import {
	IChatWidgetFixtureHandle,
	renderChatWidget,
} from "./chatWidget.fixture.js";

/**
 * A Thrice provider turn as the extension streams it: external tool calls named like Claude's
 * tools (Read, Grep, LS, Edit, Write, Bash) with no structured summary, thinking with no timing
 * of its own, and edit calls carrying `thriceFileEdit` data.
 */
interface IThriceStep {
	readonly id: string;
	readonly tool: string;
	readonly message: string;
	readonly fileEdit?: IChatThriceFileEditData;
	readonly terminal?: IChatTerminalToolInvocationData;
	readonly running?: boolean;
	readonly subagent?: IChatSubagentToolInvocationData;
	/** The runAgent call this step runs under. */
	readonly parent?: string;
}

const file = (path: string) => `file:///workspace/${path}`;

const exploration: readonly IThriceStep[] = [
	{
		id: "r1",
		tool: "Read",
		message: `Read [](${file("src/activity.ts")}), lines 120-180`,
	},
	{ id: "r2", tool: "Read", message: `Read [](${file("src/events.ts")})` },
	{ id: "g1", tool: "Grep", message: "Searching `isRunAgentTool`" },
	{ id: "r3", tool: "Read", message: `Read [](${file("src/agents.ts")})` },
	{ id: "g2", tool: "Glob", message: "Searching `src/**/*.test.ts`" },
	{ id: "l1", tool: "LS", message: `Listed [](${file("src/sessions")})` },
];

const edits: readonly IThriceStep[] = [
	{
		id: "e1",
		tool: "Edit",
		message: `Edited [](${file("src/activity.ts")})`,
		fileEdit: {
			kind: "thriceFileEdit",
			uri: file("src/activity.ts"),
			added: 12,
			removed: 3,
			change: "update",
		},
	},
	{
		id: "e2",
		tool: "Write",
		message: `Wrote [](${file("test/pairing.test.ts")})`,
		fileEdit: {
			kind: "thriceFileEdit",
			uri: file("test/pairing.test.ts"),
			added: 48,
			removed: 0,
			change: "add",
		},
	},
];

const command: IThriceStep = {
	id: "b1",
	tool: "Bash",
	message: "Ran `npm test`",
	terminal: {
		kind: "terminal",
		commandLine: { original: "npm test" },
		language: "sh",
		terminalCommandOutput: {
			text: "> thrice-providers@1.0.0 test\r\n> node --test test/*.test.ts\r\n\r\n✔ pairs runs by prompt (2.1ms)\r\n✔ nests child tool calls (0.8ms)\r\nℹ tests 49\r\nℹ pass 49\r\nℹ fail 0",
		},
		terminalCommandState: { exitCode: 0, duration: 1800 },
	},
};

const review: readonly IThriceStep[] = [
	{
		id: "sa1",
		tool: "mcp__thrice__runAgent",
		message: "Running agent `codex-hub` Audit the pairing change",
		subagent: {
			kind: "subagent",
			description: "Audit the pairing change",
			agentName: "codex-hub",
			chatProvider: "codex-hub",
			modelName: "gpt-6.1-sol",
			prompt: "Audit the pairing change in src/activity.ts for regressions.",
			result:
				"Run agent-1: Codex Hub, done after 41s, 2 tool calls.\n\nNo regressions: pairing by prompt is strict and the fallback only applies to unmatched calls.",
		},
	},
	{
		id: "sa1-r1",
		tool: "Read",
		parent: "sa1",
		message: `Read [](${file("src/activity.ts")})`,
	},
	{
		id: "sa1-g1",
		tool: "Grep",
		parent: "sa1",
		message: "Searching `started(`",
	},
];

async function acceptStep(
	model: IChatWidgetFixtureHandle["model"],
	step: IThriceStep,
): Promise<void> {
	const request = model.getRequests()[0];
	const tool = new ChatToolInvocation(
		{
			invocationMessage: new MarkdownString(step.message),
			// Like the extension: a command's card shows it, so it has no past-tense line.
			pastTenseMessage: step.terminal
				? undefined
				: new MarkdownString(step.message),
		},
		{
			id: step.tool,
			displayName: step.tool,
			modelDescription: step.tool,
			source: ToolDataSource.Internal,
		},
		step.id,
		step.parent,
		{},
	);
	const data = step.fileEdit ?? step.terminal ?? step.subagent;
	if (data) {
		(
			tool as unknown as {
				toolSpecificData:
					| IChatThriceFileEditData
					| IChatTerminalToolInvocationData
					| IChatSubagentToolInvocationData;
			}
		).toolSpecificData = data;
	}
	if (!step.running) {
		await tool.didExecuteTool({ content: [] });
	}
	model.acceptResponseProgress(request, tool);
}

async function renderThriceTrace(
	context: ComponentFixtureContext,
	options: { readonly width: number; readonly running?: boolean },
): Promise<void> {
	let handle: IChatWidgetFixtureHandle | undefined;
	await renderChatWidget(context, {
		width: options.width,
		height: 720,
		listHeight: 720,
		inputVisible: false,
		persistentProgress: ChatProgressAnimation.Draw,
		persistentProgressVerbosity: ChatProgressVerbosity.Compact,
		collapseCompletedResponses: false,
		// The app defaults: commands render as collapsible "Ran …" rows.
		terminalToolsInThinking: true,
		simpleTerminalCollapsible: true,
		thinkingPhrases: ["Working"],
		messages: [
			{
				user: "Why do sub-agent cards show the wrong provider?",
				responseComplete: false,
				assistant: [],
			},
		],
		onRendered: (value) => (handle = value),
	});
	if (!handle) {
		throw new Error("Thrice trace fixture did not initialize");
	}
	const { model } = handle;
	const request = model.getRequests()[0];
	model.acceptResponseProgress(request, {
		kind: "thinking",
		value:
			"The renderer pairs child runs with runAgent calls. If two calls start together the pairing may pick the wrong one, so check how started() matches them.",
		id: "reasoning-1",
	});
	model.acceptResponseProgress(request, {
		kind: "thinking",
		value: "",
		id: "reasoning-1",
		reasoningDurationMs: 6200,
	});
	for (const step of exploration) {
		await acceptStep(model, step);
	}
	model.acceptResponseProgress(request, {
		kind: "markdownContent",
		content: new MarkdownString(
			"`started()` pairs by prompt but falls back to the oldest open call, so a run reported out of order can land on the wrong card. I will pair strictly by prompt first.",
		),
	});
	for (const step of edits) {
		await acceptStep(model, step);
	}
	for (const step of review) {
		await acceptStep(model, step);
	}
	await acceptStep(model, { ...command, running: options.running });
	if (!options.running) {
		model.acceptResponseProgress(request, {
			kind: "markdownContent",
			content: new MarkdownString(
				"Fixed: runs now pair by prompt, and the new test covers two runs reported out of order.",
			),
		});
		request.response?.complete();
	}
	await waitForFixtureCondition(() => {
		const rows = context.container.querySelectorAll(
			".chat-thrice-file-edit",
		).length;
		const animating =
			!options.running &&
			context.container
				.getAnimations({ subtree: true })
				.some(
					(animation) =>
						(animation.playState === "running" || animation.pending) &&
						animation.effect?.getComputedTiming().endTime !== Infinity,
				);
		return rows === edits.length && !animating;
	}, "Thrice trace did not settle");
}

export default defineThemedFixtureGroup(
	{ path: "chat/" },
	{
		ThriceTrace: defineComponentFixture({
			render: (context) => renderThriceTrace(context, { width: 520 }),
		}),
		ThriceTraceRunning: defineComponentFixture({
			render: (context) =>
				renderThriceTrace(context, { width: 520, running: true }),
		}),
		ThriceTraceNarrow: defineComponentFixture({
			render: (context) => renderThriceTrace(context, { width: 300 }),
		}),
	},
);
