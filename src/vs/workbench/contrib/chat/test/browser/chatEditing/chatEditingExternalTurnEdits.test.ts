/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "assert";
import { Event } from "../../../../../../base/common/event.js";
import {
	Disposable,
	DisposableStore,
	IDisposable,
} from "../../../../../../base/common/lifecycle.js";
import { waitForState } from "../../../../../../base/common/observable.js";
import { assertType } from "../../../../../../base/common/types.js";
import { URI } from "../../../../../../base/common/uri.js";
import { mock } from "../../../../../../base/test/common/mock.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from "../../../../../../base/test/common/utils.js";
import {
	IBulkEditResult,
	IBulkEditService,
} from "../../../../../../editor/browser/services/bulkEditService.js";
import { IEditorWorkerService } from "../../../../../../editor/common/services/editorWorker.js";
import { EditOperation } from "../../../../../../editor/common/core/editOperation.js";
import { EditSources } from "../../../../../../editor/common/textModelEditSource.js";
import { IModelService } from "../../../../../../editor/common/services/model.js";
import { ITextModelService } from "../../../../../../editor/common/services/resolverService.js";
import { ICommandService } from "../../../../../../platform/commands/common/commands.js";
import { NullCommandService } from "../../../../../../platform/commands/test/common/nullCommandService.js";
import { IFileService } from "../../../../../../platform/files/common/files.js";
import { TestConfigurationService } from "../../../../../../platform/configuration/test/common/testConfigurationService.js";
import { SyncDescriptor } from "../../../../../../platform/instantiation/common/descriptors.js";
import { ServiceCollection } from "../../../../../../platform/instantiation/common/serviceCollection.js";
import { MockContextKeyService } from "../../../../../../platform/keybinding/test/common/mockKeybindingService.js";
import { IWorkbenchAssignmentService } from "../../../../../services/assignment/common/assignmentService.js";
import { NullWorkbenchAssignmentService } from "../../../../../services/assignment/test/common/nullAssignmentService.js";
import { nullExtensionDescription } from "../../../../../services/extensions/common/extensions.js";
import { IWorkspaceEditingService } from "../../../../../services/workspaces/common/workspaceEditing.js";
import { TestFileService } from "../../../../../test/common/workbenchTestServices.js";
import { workbenchInstantiationService } from "../../../../../test/browser/workbenchTestServices.js";
import { TestWorkerService } from "../../../../inlineChat/test/browser/testWorkerService.js";
import { IAiEditTelemetryService } from "../../../../editTelemetry/browser/telemetry/aiEditTelemetry/aiEditTelemetryService.js";
import { IMcpService } from "../../../../mcp/common/mcpTypes.js";
import { TestMcpService } from "../../../../mcp/test/common/testMcpService.js";
import {
	IMultiDiffSourceResolver,
	IMultiDiffSourceResolverService,
} from "../../../../multiDiffEditor/browser/multiDiffSourceResolverService.js";
import { NotebookTextModel } from "../../../../notebook/common/model/notebookTextModel.js";
import { INotebookService } from "../../../../notebook/common/notebookService.js";
import { ChatEditingService } from "../../../browser/chatEditing/chatEditingServiceImpl.js";
import { ChatEditingSession } from "../../../browser/chatEditing/chatEditingSession.js";
import { ChatSessionsService } from "../../../browser/chatSessions/chatSessions.contribution.js";
import { resolveThriceTurn } from "../../../browser/thriceRecordTurnEdits.js";
import { IChatVariablesService } from "../../../common/attachments/chatVariables.js";
import { IChatDebugService } from "../../../common/chatDebugService.js";
import { ChatDebugServiceImpl } from "../../../common/chatDebugServiceImpl.js";
import {
	ChatOpenDiagnosticsService,
	IChatOpenDiagnosticsService,
} from "../../../common/chatOpenDiagnosticsService.js";
import { IChatService } from "../../../common/chatService/chatService.js";
import { ChatService } from "../../../common/chatService/chatServiceImpl.js";
import { IChatSessionsService } from "../../../common/chatSessionsService.js";
import { ChatAgentLocation, ChatModeKind } from "../../../common/constants.js";
import {
	IChatEditingService,
	ModifiedFileEntryState,
} from "../../../common/editing/chatEditingService.js";
import { ILanguageModelsService } from "../../../common/languageModels.js";
import { ChatModel } from "../../../common/model/chatModel.js";
import {
	ChatTransferService,
	IChatTransferService,
} from "../../../common/model/chatTransferService.js";
import {
	ChatAgentService,
	IChatAgentData,
	IChatAgentService,
} from "../../../common/participants/chatAgents.js";
import { IChatSlashCommandService } from "../../../common/participants/chatSlashCommands.js";
import { ICustomizationMigrationService } from "../../../common/promptSyntax/service/customizationMigrationService.js";
import { ICustomizationMigrationTelemetryService } from "../../../common/promptSyntax/service/customizationMigrationTelemetryService.js";
import { IPromptsService } from "../../../common/promptSyntax/service/promptsService.js";
import {
	parseThriceTurnEditsArgs,
	THRICE_PROVIDERS_CHAT_PARTICIPANT_ID,
} from "../../../common/thriceTurnEdits.js";
import { NullLanguageModelsService } from "../../common/languageModels.js";
import { MockChatVariablesService } from "../../common/mockChatVariables.js";
import { MockPromptsService } from "../../common/promptSyntax/service/mockPromptsService.js";

function getAgentData(id: string): IChatAgentData {
	return {
		name: id,
		id,
		extensionId: nullExtensionDescription.identifier,
		extensionVersion: undefined,
		extensionPublisherId: "",
		publisherDisplayName: "",
		extensionDisplayName: "",
		locations: [ChatAgentLocation.Chat],
		modes: [ChatModeKind.Ask],
		metadata: {},
		slashCommands: [],
		disambiguation: [],
	};
}

suite("ChatEditingSession external turn edits", function () {
	const store = new DisposableStore();
	let chatService: IChatService;
	let textModelService: ITextModelService;
	let modelService: IModelService;
	let fileService: TestFileService;

	/** What the 'test' scheme serves as file content, i.e. what the agent left "on disk". */
	const disk = new Map<string, string>();

	setup(function () {
		disk.clear();
		const collection = new ServiceCollection();
		collection.set(ICommandService, NullCommandService);
		collection.set(
			IWorkbenchAssignmentService,
			new NullWorkbenchAssignmentService(),
		);
		collection.set(IChatAgentService, new SyncDescriptor(ChatAgentService));
		collection.set(IChatVariablesService, new MockChatVariablesService());
		collection.set(
			IChatSlashCommandService,
			new (class extends mock<IChatSlashCommandService>() {})(),
		);
		collection.set(
			IChatTransferService,
			new SyncDescriptor(ChatTransferService),
		);
		collection.set(
			IChatSessionsService,
			new SyncDescriptor(ChatSessionsService),
		);
		collection.set(IChatEditingService, new SyncDescriptor(ChatEditingService));
		collection.set(IEditorWorkerService, new SyncDescriptor(TestWorkerService));
		collection.set(IChatService, new SyncDescriptor(ChatService));
		collection.set(
			IChatOpenDiagnosticsService,
			new SyncDescriptor(ChatOpenDiagnosticsService),
		);
		collection.set(IMcpService, new TestMcpService());
		collection.set(IPromptsService, new MockPromptsService());
		collection.set(
			ICustomizationMigrationService,
			new (class extends mock<ICustomizationMigrationService>() {})(),
		);
		collection.set(
			ICustomizationMigrationTelemetryService,
			new (class extends mock<ICustomizationMigrationTelemetryService>() {})(),
		);
		collection.set(
			ILanguageModelsService,
			new SyncDescriptor(NullLanguageModelsService),
		);
		collection.set(
			IBulkEditService,
			new (class extends mock<IBulkEditService>() {
				// Restoring a checkpoint deletes files created during the turn.
				override async apply(): Promise<IBulkEditResult> {
					return { ariaSummary: "", isApplied: true };
				}
			})(),
		);
		collection.set(
			IAiEditTelemetryService,
			new (class extends mock<IAiEditTelemetryService>() {
				override handleCodeAccepted(): void {}
				override handleCodeRejected(): void {}
			})(),
		);
		const contextKeyService = store.add(new MockContextKeyService());
		collection.set(
			IChatDebugService,
			store.add(
				new ChatDebugServiceImpl(
					new TestConfigurationService(),
					contextKeyService,
				),
			),
		);
		collection.set(
			IMultiDiffSourceResolverService,
			new (class extends mock<IMultiDiffSourceResolverService>() {
				override registerResolver(
					_resolver: IMultiDiffSourceResolver,
				): IDisposable {
					return Disposable.None;
				}
			})(),
		);
		collection.set(
			IWorkspaceEditingService,
			new (class extends mock<IWorkspaceEditingService>() {
				override readonly onDidEnterWorkspace = Event.None;
			})(),
		);
		collection.set(
			INotebookService,
			new (class extends mock<INotebookService>() {
				override getNotebookTextModel(
					_uri: URI,
				): NotebookTextModel | undefined {
					return undefined;
				}
				override hasSupportedNotebooks(_resource: URI): boolean {
					return false;
				}
			})(),
		);
		const insta = store.add(
			store
				.add(workbenchInstantiationService(undefined, store))
				.createChild(collection),
		);
		store.add(insta.get(IEditorWorkerService) as TestWorkerService);
		assert.ok(insta.get(IChatEditingService) instanceof ChatEditingService);

		chatService = insta.get(IChatService);
		store.add(insta.get(IChatSessionsService) as ChatSessionsService);
		store.add(chatService as ChatService);
		chatService.setSaveModelsEnabled(false);

		const chatAgentService = insta.get(IChatAgentService);
		store.add(
			chatAgentService.registerAgent(THRICE_PROVIDERS_CHAT_PARTICIPANT_ID, {
				...getAgentData(THRICE_PROVIDERS_CHAT_PARTICIPANT_ID),
				isDefault: true,
			}),
		);
		store.add(
			chatAgentService.registerAgentImplementation(
				THRICE_PROVIDERS_CHAT_PARTICIPANT_ID,
				{
					async invoke() {
						return {};
					},
				},
			),
		);

		textModelService = insta.get(ITextModelService);
		modelService = insta.get(IModelService);
		const files = insta.get(IFileService);
		assert.ok(files instanceof TestFileService);
		fileService = files;
		store.add(
			textModelService.registerTextModelContentProvider("test", {
				async provideTextContent(resource) {
					const content = disk.get(resource.toString());
					return content === undefined
						? null
						: store.add(
								modelService.createModel(content, null, resource, false),
							);
				},
			}),
		);
	});

	teardown(() => {
		store.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	function startTurn(complete = true) {
		const modelRef = store.add(
			chatService.startNewLocalSession(ChatAgentLocation.Chat),
		);
		const model = modelRef.object as ChatModel;
		const session = model.editingSession;
		assert.ok(session instanceof ChatEditingSession);
		const request = model.addRequest(
			{ text: "change things", parts: [] },
			{ variables: [] },
			0,
			undefined,
			getAgentData(THRICE_PROVIDERS_CHAT_PARTICIPANT_ID),
		);
		assertType(request.response);
		if (complete) {
			request.response.complete();
		}
		return { model, session, request, response: request.response };
	}

	async function contents(session: ChatEditingSession, uri: URI) {
		const entry = session.getEntry(uri);
		assertType(entry);
		const original = store.add(
			await textModelService.createModelReference(entry.originalURI),
		).object.textEditorModel;
		const modified = store.add(
			await textModelService.createModelReference(entry.modifiedURI),
		).object.textEditorModel;
		return {
			original: original.getValue(),
			modified: modified.getValue(),
			state: entry.state.get(),
		};
	}

	async function requestDiffs(session: ChatEditingSession, requestId: string) {
		const diffs = await waitForState(
			session
				.getDiffsForFilesInRequest(requestId)
				.map((d) => (d.length > 0 && !d.some((x) => x.isBusy) ? d : undefined)),
		);
		return diffs
			.map((d) => ({
				path: d.modifiedURI.path,
				added: d.added,
				removed: d.removed,
			}))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	const before = "one\ntwo\nthree\n";
	const after = "one\nTWO\nthree\nfour\n";

	/** What a reload from disk does to an open model while the agent writes the file. */
	async function agentWrites(uri: URI, content: string) {
		disk.set(uri.toString(), content);
		const model = store.add(await textModelService.createModelReference(uri))
			.object.textEditorModel;
		modelService.updateModel(model, content, EditSources.reloadFromDisk());
	}

	test("partial recordings keep the turn baseline and the external turn", async function () {
		const uri = URI.from({ scheme: "test", path: "/partial.txt" });
		const created = URI.from({ scheme: "test", path: "/partial-created.txt" });
		const { session, response } = startTurn(false);

		// First tool: `before` is the turn start content.
		disk.set(uri.toString(), "one\nTWO\nthree\n");
		await session.recordExternalTurnEdits(
			response,
			[{ uri, before, after: "one\nTWO\nthree\n" }],
			{ partial: true },
		);

		// Second tool: `before` is the content before that tool; the turn baseline must win.
		await agentWrites(uri, after);
		disk.set(created.toString(), "new\n");
		const recorded = await session.recordExternalTurnEdits(
			response,
			[
				{ uri, before: "one\nTWO\nthree\n", after },
				{ uri: created, before: undefined, after: "new\n" },
			],
			{ partial: true },
		);

		// The agent keeps writing: the external turn is still active, also for the entry the
		// partial recording created, so the reload counts as an agent edit, not a user edit.
		await agentWrites(created, "new\nmore\n");

		assert.deepStrictEqual(
			{
				recorded: recorded.map((u) => u.path),
				edited: await contents(session, uri),
				created: await contents(session, created),
			},
			{
				recorded: ["/partial.txt", "/partial-created.txt"],
				edited: {
					original: before,
					modified: after,
					state: ModifiedFileEntryState.Modified,
				},
				created: {
					original: "",
					modified: "new\nmore\n",
					state: ModifiedFileEntryState.Modified,
				},
			},
		);

		await session.recordExternalTurnEdits(response, []);
		response.complete();
	});

	test("typing in a file during an external turn is a user edit, a reload is an agent edit", async function () {
		const uri = URI.from({ scheme: "test", path: "/typed.txt" });
		const { session, response } = startTurn(false);
		disk.set(uri.toString(), "one\nTWO\nthree\n");
		await session.recordExternalTurnEdits(
			response,
			[{ uri, before, after: "one\nTWO\nthree\n" }],
			{ partial: true },
		);

		// The user types a line at the top while the agent runs: it is folded into the original.
		const model = store.add(await textModelService.createModelReference(uri))
			.object.textEditorModel;
		model.pushEditOperations(
			null,
			[
				EditOperation.insert(
					model.getFullModelRange().getStartPosition(),
					"mine\n",
				),
			],
			() => null,
		);
		// The agent writes the file again (keeping the user's line): only its change shows as the agent's.
		await agentWrites(uri, "mine\none\nTWO\nthree\nfour\n");

		assert.deepStrictEqual(await contents(session, uri), {
			original: "mine\none\ntwo\nthree\n",
			modified: "mine\none\nTWO\nthree\nfour\n",
			state: ModifiedFileEntryState.Modified,
		});

		await session.recordExternalTurnEdits(response, []);
		response.complete();
	});

	test("final recording after partial ones is idempotent and reconciles unlisted files", async function () {
		const a = URI.from({ scheme: "test", path: "/a.txt" });
		const b = URI.from({ scheme: "test", path: "/b.txt" });
		const c = URI.from({ scheme: "test", path: "/c.txt" });
		const { session, request, response } = startTurn(false);

		disk.set(a.toString(), "one\nTWO\nthree\n");
		disk.set(b.toString(), "new\n");
		disk.set(c.toString(), "one\ntwo\nTHREE\n");
		await session.recordExternalTurnEdits(
			response,
			[
				{ uri: a, before, after: "one\nTWO\nthree\n" },
				{ uri: b, before: undefined, after: "new\n" },
				{ uri: c, before, after: "one\ntwo\nTHREE\n" },
			],
			{ partial: true },
		);

		// More writes after the last partial recording: `a` is listed in the final call,
		// `c` is not (e.g. the end-of-turn diff missed it) and is read from disk.
		await agentWrites(a, after);
		await agentWrites(c, "one\ntwo\nTHREE\nfour\n");
		fileService.setContent("one\ntwo\nTHREE\nfour\n");
		const recorded = await session.recordExternalTurnEdits(response, [
			{ uri: a, before, after },
			{ uri: b, before: undefined, after: "new\n" },
		]);
		response.complete();

		assert.deepStrictEqual(
			{
				recorded: recorded.map((u) => u.path),
				entries: session.entries
					.get()
					.map((e) => e.modifiedURI.path)
					.sort(),
				a: await contents(session, a),
				b: await contents(session, b),
				c: await contents(session, c),
				diffs: await requestDiffs(session, request.id),
			},
			{
				recorded: ["/a.txt", "/b.txt"],
				entries: ["/a.txt", "/b.txt", "/c.txt"],
				a: {
					original: before,
					modified: after,
					state: ModifiedFileEntryState.Modified,
				},
				b: {
					original: "",
					modified: "new\n",
					state: ModifiedFileEntryState.Modified,
				},
				c: {
					original: before,
					modified: "one\ntwo\nTHREE\nfour\n",
					state: ModifiedFileEntryState.Modified,
				},
				diffs: [
					{ path: "/a.txt", added: 2, removed: 1 },
					{ path: "/b.txt", added: 2, removed: 1 },
					{ path: "/c.txt", added: 2, removed: 1 },
				],
			},
		);

		// The timeline holds one consistent history per file: restoring the request puts the baseline back.
		await session.restoreSnapshot(request.id, undefined);
		const aModel = store.add(await textModelService.createModelReference(a))
			.object.textEditorModel;
		const cModel = store.add(await textModelService.createModelReference(c))
			.object.textEditorModel;
		assert.deepStrictEqual(
			[aModel.getValue(), cModel.getValue()],
			[before, before],
		);
	});

	test("record -> summary entries -> undo restores before", async function () {
		const uri = URI.from({ scheme: "test", path: "/edited.txt" });
		disk.set(uri.toString(), after);
		const { session, request, response } = startTurn();

		const recorded = await session.recordExternalTurnEdits(response, [
			{ uri, before, after },
		]);
		assert.deepStrictEqual(
			recorded.map((u) => u.toString()),
			[uri.toString()],
		);

		// Working set entry: original = before, current = after, pending review.
		const entry = session.getEntry(uri);
		assertType(entry);
		assert.strictEqual(entry.state.get(), ModifiedFileEntryState.Modified);
		assert.strictEqual(entry.lastModifyingRequestId, request.id);
		const original = store.add(
			await textModelService.createModelReference(entry.originalURI),
		).object.textEditorModel;
		const modified = store.add(
			await textModelService.createModelReference(entry.modifiedURI),
		).object.textEditorModel;
		assert.strictEqual(original.getValue(), before);
		assert.strictEqual(modified.getValue(), after);

		// Per-request "Changed N files" summary.
		assert.strictEqual(session.hasEditsInRequest(request.id), true);
		const diffs = await waitForState(
			session
				.getDiffsForFilesInRequest(request.id)
				.map((d) => (d.length > 0 && !d.some((x) => x.isBusy) ? d : undefined)),
		);
		assert.strictEqual(diffs.length, 1);
		assert.strictEqual(diffs[0].modifiedURI.path, uri.path);
		assert.deepStrictEqual(
			{ added: diffs[0].added, removed: diffs[0].removed },
			{ added: 2, removed: 1 },
		);

		// Undo puts `before` back.
		await entry.reject();
		assert.strictEqual(entry.state.get(), ModifiedFileEntryState.Rejected);
		assert.strictEqual(modified.getValue(), before);
	});

	test("record -> keep", async function () {
		const uri = URI.from({ scheme: "test", path: "/kept.txt" });
		disk.set(uri.toString(), after);
		const { session, response } = startTurn();

		await session.recordExternalTurnEdits(response, [{ uri, before, after }]);
		const entry = session.getEntry(uri);
		assertType(entry);

		await session.accept(uri);
		assert.strictEqual(entry.state.get(), ModifiedFileEntryState.Accepted);
		const modified = store.add(
			await textModelService.createModelReference(entry.modifiedURI),
		).object.textEditorModel;
		const original = store.add(
			await textModelService.createModelReference(entry.originalURI),
		).object.textEditorModel;
		assert.strictEqual(modified.getValue(), after);
		assert.strictEqual(original.getValue(), after);
	});

	test("restore checkpoint puts before back", async function () {
		const uri = URI.from({ scheme: "test", path: "/restored.txt" });
		disk.set(uri.toString(), after);
		const { session, request, response } = startTurn();

		await session.recordExternalTurnEdits(response, [{ uri, before, after }]);
		const modified = store.add(await textModelService.createModelReference(uri))
			.object.textEditorModel;
		assert.strictEqual(modified.getValue(), after);

		await session.restoreSnapshot(request.id, undefined);
		assert.strictEqual(modified.getValue(), before);
	});

	test("created file is reviewed against empty content and undo removes the entry", async function () {
		const uri = URI.from({ scheme: "test", path: "/created.txt" });
		disk.set(uri.toString(), after);
		const { session, response } = startTurn();

		await session.recordExternalTurnEdits(response, [
			{ uri, before: undefined, after },
		]);
		const entry = session.getEntry(uri);
		assertType(entry);
		const original = store.add(
			await textModelService.createModelReference(entry.originalURI),
		).object.textEditorModel;
		assert.strictEqual(original.getValue(), "");

		await entry.reject();
		assert.strictEqual(session.getEntry(uri), undefined);
	});

	test("deleted file gets a deletion entry", async function () {
		const uri = URI.from({ scheme: "test", path: "/deleted.txt" });
		const { session, response } = startTurn();

		await session.recordExternalTurnEdits(response, [
			{ uri, before, after: undefined },
		]);
		const entry = session.getEntry(uri);
		assertType(entry);
		assert.strictEqual(entry.isDeletion, true);
		assert.strictEqual(entry.state.get(), ModifiedFileEntryState.Modified);
	});

	test("resolves the turn from session resource, request id, or the latest Thrice session", function () {
		const { model, request } = startTurn();
		assert.strictEqual(
			resolveThriceTurn(
				chatService.chatModels.get(),
				model.sessionResource,
				request.id,
			)?.request,
			request,
		);
		assert.strictEqual(
			resolveThriceTurn(
				chatService.chatModels.get(),
				model.sessionResource,
				undefined,
			)?.request,
			request,
		);
		assert.strictEqual(
			resolveThriceTurn(chatService.chatModels.get(), undefined, request.id)
				?.request,
			request,
		);
		assert.strictEqual(
			resolveThriceTurn(chatService.chatModels.get(), undefined, undefined)
				?.request,
			request,
		);
		assert.strictEqual(
			resolveThriceTurn(
				chatService.chatModels.get(),
				model.sessionResource,
				"nope",
			),
			undefined,
		);
	});

	test("parses command arguments", function () {
		const token = {
			sessionResource: URI.parse("vscode-chat-session://local/abc"),
			requestId: "r1",
		};
		const parsed = parseThriceTurnEditsArgs({
			toolInvocationToken: token,
			partial: true,
			edits: [
				{ uri: "file:///a.txt", before: "x", after: "y" },
				{ uri: "file:///b.txt", before: null, after: "new" },
				{ uri: "file:///c.txt", before: "old", after: null },
				{ uri: "file:///same.txt", before: "same", after: "same" },
			],
		});
		assertType(parsed);
		assert.strictEqual(
			parsed.sessionResource?.toString(),
			token.sessionResource.toString(),
		);
		assert.strictEqual(parsed.requestId, "r1");
		assert.strictEqual(parsed.partial, true);
		assert.strictEqual(parseThriceTurnEditsArgs({ edits: [] })?.partial, false);
		assert.strictEqual(
			parseThriceTurnEditsArgs({ edits: [], partial: "yes" })?.partial,
			false,
		);
		assert.deepStrictEqual(
			parsed.edits.map((e) => [e.uri.toString(), e.before, e.after]),
			[
				["file:///a.txt", "x", "y"],
				["file:///b.txt", undefined, "new"],
				["file:///c.txt", "old", undefined],
			],
		);
		assert.strictEqual(parseThriceTurnEditsArgs({ edits: "nope" }), undefined);
		assert.strictEqual(parseThriceTurnEditsArgs(undefined), undefined);
	});
});
