/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The provider a chat shows. A chat that already has a model keeps that model's provider.
 * A new chat, which has none yet, uses the last provider someone picked.
 */
export function sessionChatProviderId(currentVendor: string | undefined, providers: readonly { id: string }[], rememberedProviderId: string): string {
	if (currentVendor && providers.some(provider => provider.id === currentVendor)) {
		return currentVendor;
	}
	return rememberedProviderId;
}

/** A shared provider change is only for a chat that has not chosen a model yet. */
export function shouldAdoptSharedChatProvider(hasSelectedModel: boolean): boolean {
	return !hasSelectedModel;
}

const CHAT_PERMISSION_LEVELS = ['default', 'assisted', 'autoApprove', 'autopilot'] as const;

export type RememberedChatPermissionLevel = typeof CHAT_PERMISSION_LEVELS[number];

function isRememberedChatPermissionLevel(level: string | undefined): level is RememberedChatPermissionLevel {
	return !!level && (CHAT_PERMISSION_LEVELS as readonly string[]).includes(level);
}

/**
 * A new chat uses the last permission someone picked. The configured default
 * applies only when nothing has been picked yet.
 */
export function permissionLevelForNewChat(remembered: string | undefined, configured: string | undefined): RememberedChatPermissionLevel {
	if (isRememberedChatPermissionLevel(remembered)) {
		return remembered;
	}
	if (isRememberedChatPermissionLevel(configured)) {
		return configured;
	}
	return 'default';
}
