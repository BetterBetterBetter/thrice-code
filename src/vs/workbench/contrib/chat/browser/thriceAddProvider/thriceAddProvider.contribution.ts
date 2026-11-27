/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/thriceAddProvider.css';
import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ThriceAddProviderDialog } from './thriceAddProviderDialog.js';

export const THRICE_OPEN_ADD_PROVIDER_COMMAND_ID = 'thrice.openAddProvider';

registerAction2(class OpenThriceAddProviderAction extends Action2 {
	constructor() {
		super({
			id: THRICE_OPEN_ADD_PROVIDER_COMMAND_ID,
			title: localize2('thrice.openAddProvider', "Add provider"),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return ThriceAddProviderDialog.open(accessor.get(IInstantiationService));
	}
});
