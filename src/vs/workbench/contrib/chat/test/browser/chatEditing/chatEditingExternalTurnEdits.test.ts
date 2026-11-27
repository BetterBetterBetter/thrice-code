/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../../base/common/lifecycle.js';
import { waitForState } from '../../../../../../base/common/observable.js';
import { isEqual } from '../../../../../../base/common/resources.js';
import { assertType } from '../../../../../../base/common/types.js';
import { URI } from '../../../../../../base/common/uri.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IEditorWorkerService } from '../../../../../../editor/common/services/editorWorker.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../../../editor/common/services/resolverService.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { NullCommandService } from '../../../../../../platform/commands/test/common/nullCommandService.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { SyncDescriptor } from '../../../../../../platform/instantiation/common/descriptors.js';
import { ServiceCollection } from '../../../../../../platform/instantiation/common/serviceCollection.js';
import { MockContextKeyService } from '../../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IWorkbenchAssignmentService } from '../../../../../services/assignment/common/assignmentService.js';
import { NullWorkbenchAssignmentService } from '../../../../../services/assignment/test/common/nullAssignmentService.js';
import { nullExtensionDescription } from '../../../../../services/extensions/common/extensions.js';
import { IWorkspaceEditingService } from '../../../../../services/workspaces/common/workspaceEditing.js';
import { workbenchInstantiationService } from '../../../../../test/browser/workbenchTestServices.js';
import { TestWorkerService } from '../../../../inlineChat/test/browser/testWorkerService.js';
import { IMcpService } from '../../../../mcp/common/mcpTypes.js';
import { TestMcpService } from '../../../../mcp/test/common/testMcpService.js';
import { IMultiDiffSourceResolver, IMultiDiffSourceResolverService } from '../../../../multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { NotebookTextModel } from '../../../../notebook/common/model/notebookTextModel.js';
import { INotebookService } from '../../../../notebook/common/notebookService.js';
import { ChatEditingService } from '../../../browser/chatEditing/chatEditingServiceImpl.js';
import { ChatEditingSession } from '../../../browser/chatEditing/chatEditingSession.js';
import { ChatSessionsService } from '../../../browser/chatSessions/chatSessions.contribution.js';
import { resolveThriceTurn } from '../../../browser/thriceRecordTurnEdits.js';
import { IChatVariablesService } from '../../../common/attachments/chatVariables.js';
import { IChatDebugService } from '../../../common/chatDebugService.js';
import { ChatDebugServiceImpl } from '../../../common/chatDebugServiceImpl.js';
import { ChatOpenDiagnosticsService, IChatOpenDiagnosticsService } from '../../../common/chatOpenDiagnosticsService.js';
import { IChatService } from '../../../common/chatService/chatService.js';
import { ChatService } from '../../../common/chatService/chatServiceImpl.js';
import { IChatSessionsService } from '../../../common/chatSessionsService.js';
import { ChatAgentLocation, ChatModeKind } from '../../../common/constants.js';
import { IChatEditingService, ModifiedFileEntryState } from '../../../common/editing/chatEditingService.js';
import { ILanguageModelsService } from '../../../common/languageModels.js';
import { ChatModel } from '../../../common/model/chatModel.js';
import { ChatTransferService, IChatTransferService } from '../../../common/model/chatTransferService.js';
import { ChatAgentService, IChatAgentData, IChatAgentService } from '../../../common/participants/chatAgents.js';
import { IChatSlashCommandService } from '../../../common/participants/chatSlashCommands.js';
import { ICustomizationMigrationService } from '../../../common/promptSyntax/service/customizationMigrationService.js';
import { ICustomizationMigrationTelemetryService } from '../../../common/promptSyntax/service/customizationMigrationTelemetryService.js';
import { IPromptsService } from '../../../common/promptSyntax/service/promptsService.js';
import { parseThriceTurnEditsArgs, THRICE_PROVIDERS_CHAT_PARTICIPANT_ID } from '../../../common/thriceTurnEdits.js';
import { NullLanguageModelsService } from '../../common/languageModels.js';
import { MockChatVariablesService } from '../../common/mockChatVariables.js';
import { MockPromptsService } from '../../common/promptSyntax/service/mockPromptsService.js';

function getAgentData(id: string): IChatAgentData {
	return {
		name: id,
		id,
		extensionId: nullExtensionDescription.identifier,
		extensionVersion: undefined,
		extensionPublisherId: '',
		publisherDisplayName: '',
		extensionDisplayName: '',
		locations: [ChatAgentLocation.Chat],
		modes: [ChatModeKind.Ask],
		metadata: {},
		slashCommands: [],
		disambiguation: [],
	};
}

suite('ChatEditingSession external turn edits', function () {

	const store = new DisposableStore();
	let chatService: IChatService;
	let textModelService: ITextModelService;

	/** What the 'test' scheme serves as file content, i.e. what the agent left "on disk". */
	const disk = new Map<string, string>();

	setup(function () {
		disk.clear();
		const collection = new ServiceCollection();
		collection.set(ICommandService, NullCommandService);
		collection.set(IWorkbenchAssignmentService, new NullWorkbenchAssignmentService());
		collection.set(IChatAgentService, new SyncDescriptor(ChatAgentService));
		collection.set(IChatVariablesService, new MockChatVariablesService());
		collection.set(IChatSlashCommandService, new class extends mock<IChatSlashCommandService>() { });
		collection.set(IChatTransferService, new SyncDescriptor(ChatTransferService));
		collection.set(IChatSessionsService, new SyncDescriptor(ChatSessionsService));
		collection.set(IChatEditingService, new SyncDescriptor(ChatEditingService));
		collection.set(IEditorWorkerService, new SyncDescriptor(TestWorkerService));
		collection.set(IChatService, new SyncDescriptor(ChatService));
		collection.set(IChatOpenDiagnosticsService, new SyncDescriptor(ChatOpenDiagnosticsService));
		collection.set(IMcpService, new TestMcpService());
		collection.set(IPromptsService, new MockPromptsService());
		collection.set(ICustomizationMigrationService, new class extends mock<ICustomizationMigrationService>() { });
		collection.set(ICustomizationMigrationTelemetryService, new class extends mock<ICustomizationMigrationTelemetryService>() { });
		collection.set(ILanguageModelsService, new SyncDescriptor(NullLanguageModelsService));
		const contextKeyService = store.add(new MockContextKeyService());
		collection.set(IChatDebugService, store.add(new ChatDebugServiceImpl(new TestConfigurationService(), contextKeyService)));
		collection.set(IMultiDiffSourceResolverService, new class extends mock<IMultiDiffSourceResolverService>() {
			override registerResolver(_resolver: IMultiDiffSourceResolver): IDisposable {
				return Disposable.None;
			}
		});
		collection.set(IWorkspaceEditingService, new class extends mock<IWorkspaceEditingService>() {
			override readonly onDidEnterWorkspace = Event.None;
		});
		collection.set(INotebookService, new class extends mock<INotebookService>() {
			override getNotebookTextModel(_uri: URI): NotebookTextModel | undefined {
				return undefined;
			}
			override hasSupportedNotebooks(_resource: URI): boolean {
				return false;
			}
		});
		const insta = store.add(store.add(workbenchInstantiationService(undefined, store)).createChild(collection));
		store.add(insta.get(IEditorWorkerService) as TestWorkerService);
		assert.ok(insta.get(IChatEditingService) instanceof ChatEditingService);

		chatService = insta.get(IChatService);
		store.add(insta.get(IChatSessionsService) as ChatSessionsService);
		store.add(chatService as ChatService);
		chatService.setSaveModelsEnabled(false);

		const chatAgentService = insta.get(IChatAgentService);
		store.add(chatAgentService.registerAgent(THRICE_PROVIDERS_CHAT_PARTICIPANT_ID, { ...getAgentData(THRICE_PROVIDERS_CHAT_PARTICIPANT_ID), isDefault: true }));
		store.add(chatAgentService.registerAgentImplementation(THRICE_PROVIDERS_CHAT_PARTICIPANT_ID, { async invoke() { return {}; } }));

		textModelService = insta.get(ITextModelService);
		const modelService = insta.get(IModelService);
		store.add(textModelService.registerTextModelContentProvider('test', {
			async provideTextContent(resource) {
				const content = disk.get(resource.toString());
				return content === undefined ? null : store.add(modelService.createModel(content, null, resource, false));
			},
		}));
	});

	teardown(() => {
		store.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	function startTurn() {
		const modelRef = store.add(chatService.startNewLocalSession(ChatAgentLocation.Chat));
		const model = modelRef.object as ChatModel;
		const session = model.editingSession;
		assert.ok(session instanceof ChatEditingSession);
		const request = model.addRequest({ text: 'change things', parts: [] }, { variables: [] }, 0);
		assertType(request.response);
		request.response.complete();
		return { model, session, request, response: request.response };
	}

	const before = 'one\ntwo\nthree\n';
	const after = 'one\nTWO\nthree\nfour\n';

	test('record -> summary entries -> undo restores before', async function () {
		const uri = URI.from({ scheme: 'test', path: '/edited.txt' });
		disk.set(uri.toString(), after);
		const { session, request, response } = startTurn();

		const recorded = await session.recordExternalTurnEdits(response, [{ uri, before, after }]);
		assert.deepStrictEqual(recorded.map(u => u.toString()), [uri.toString()]);

		// Working set entry: original = before, current = after, pending review.
		const entry = session.getEntry(uri);
		assertType(entry);
		assert.strictEqual(entry.state.get(), ModifiedFileEntryState.Modified);
		assert.strictEqual(entry.lastModifyingRequestId, request.id);
		const original = store.add(await textModelService.createModelReference(entry.originalURI)).object.textEditorModel;
		const modified = store.add(await textModelService.createModelReference(entry.modifiedURI)).object.textEditorModel;
		assert.strictEqual(original.getValue(), before);
		assert.strictEqual(modified.getValue(), after);

		// Per-request "Changed N files" summary.
		assert.strictEqual(session.hasEditsInRequest(request.id), true);
		const diffs = await waitForState(session.getDiffsForFilesInRequest(request.id).map(d => d.length > 0 && !d.some(x => x.isBusy) ? d : undefined));
		assert.strictEqual(diffs.length, 1);
		assert.ok(isEqual(diffs[0].modifiedURI, uri));
		assert.deepStrictEqual({ added: diffs[0].added, removed: diffs[0].removed }, { added: 2, removed: 1 });

		// Undo puts `before` back.
		await entry.reject();
		assert.strictEqual(entry.state.get(), ModifiedFileEntryState.Rejected);
		assert.strictEqual(modified.getValue(), before);
	});

	test('record -> keep', async function () {
		const uri = URI.from({ scheme: 'test', path: '/kept.txt' });
		disk.set(uri.toString(), after);
		const { session, response } = startTurn();

		await session.recordExternalTurnEdits(response, [{ uri, before, after }]);
		const entry = session.getEntry(uri);
		assertType(entry);

		await session.accept(uri);
		assert.strictEqual(entry.state.get(), ModifiedFileEntryState.Accepted);
		const modified = store.add(await textModelService.createModelReference(entry.modifiedURI)).object.textEditorModel;
		const original = store.add(await textModelService.createModelReference(entry.originalURI)).object.textEditorModel;
		assert.strictEqual(modified.getValue(), after);
		assert.strictEqual(original.getValue(), after);
	});

	test('restore checkpoint puts before back', async function () {
		const uri = URI.from({ scheme: 'test', path: '/restored.txt' });
		disk.set(uri.toString(), after);
		const { session, request, response } = startTurn();

		await session.recordExternalTurnEdits(response, [{ uri, before, after }]);
		const modified = store.add(await textModelService.createModelReference(uri)).object.textEditorModel;
		assert.strictEqual(modified.getValue(), after);

		await session.restoreSnapshot(request.id, undefined);
		assert.strictEqual(modified.getValue(), before);
	});

	test('created file is reviewed against empty content and undo removes the entry', async function () {
		const uri = URI.from({ scheme: 'test', path: '/created.txt' });
		disk.set(uri.toString(), after);
		const { session, response } = startTurn();

		await session.recordExternalTurnEdits(response, [{ uri, before: undefined, after }]);
		const entry = session.getEntry(uri);
		assertType(entry);
		const original = store.add(await textModelService.createModelReference(entry.originalURI)).object.textEditorModel;
		assert.strictEqual(original.getValue(), '');

		await entry.reject();
		assert.strictEqual(session.getEntry(uri), undefined);
	});

	test('deleted file gets a deletion entry', async function () {
		const uri = URI.from({ scheme: 'test', path: '/deleted.txt' });
		const { session, response } = startTurn();

		await session.recordExternalTurnEdits(response, [{ uri, before, after: undefined }]);
		const entry = session.getEntry(uri);
		assertType(entry);
		assert.strictEqual(entry.isDeletion, true);
		assert.strictEqual(entry.state.get(), ModifiedFileEntryState.Modified);
	});

	test('resolves the turn from session resource, request id, or the latest Thrice session', function () {
		const { model, request } = startTurn();
		assert.strictEqual(resolveThriceTurn(chatService.chatModels.get(), model.sessionResource, request.id)?.request, request);
		assert.strictEqual(resolveThriceTurn(chatService.chatModels.get(), model.sessionResource, undefined)?.request, request);
		assert.strictEqual(resolveThriceTurn(chatService.chatModels.get(), undefined, request.id)?.request, request);
		assert.strictEqual(resolveThriceTurn(chatService.chatModels.get(), undefined, undefined)?.request, request);
		assert.strictEqual(resolveThriceTurn(chatService.chatModels.get(), model.sessionResource, 'nope'), undefined);
	});

	test('parses command arguments', function () {
		const token = { sessionResource: URI.parse('vscode-chat-session://local/abc'), requestId: 'r1' };
		const parsed = parseThriceTurnEditsArgs({
			toolInvocationToken: token,
			edits: [
				{ uri: 'file:///a.txt', before: 'x', after: 'y' },
				{ uri: 'file:///b.txt', before: null, after: 'new' },
				{ uri: 'file:///c.txt', before: 'old', after: null },
				{ uri: 'file:///same.txt', before: 'same', after: 'same' },
			],
		});
		assertType(parsed);
		assert.strictEqual(parsed.sessionResource?.toString(), token.sessionResource.toString());
		assert.strictEqual(parsed.requestId, 'r1');
		assert.deepStrictEqual(parsed.edits.map(e => [e.uri.toString(), e.before, e.after]), [
			['file:///a.txt', 'x', 'y'],
			['file:///b.txt', undefined, 'new'],
			['file:///c.txt', 'old', undefined],
		]);
		assert.strictEqual(parseThriceTurnEditsArgs({ edits: 'nope' }), undefined);
		assert.strictEqual(parseThriceTurnEditsArgs(undefined), undefined);
	});
});
