/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { localize } from '../../../../../../nls.js';
import { parseThriceChart, ThriceChartSpec } from '../../../common/thriceChart.js';

const $ = dom.$;

export function renderThriceChart(text: string, complete: boolean): HTMLElement {
	const parsed = parseThriceChart(text);
	if ('error' in parsed) {
		const error = $('.thrice-chart.thrice-chart-error');
		error.textContent = complete ? parsed.error : localize('thriceChart.arriving', "Chart is still arriving.");
		return error;
	}
	return renderSpec(parsed.spec);
}

function renderSpec(spec: ThriceChartSpec): HTMLElement {
	const root = $('.thrice-chart');
	const toolbar = dom.append(root, $('.thrice-chart-toolbar'));
	const title = dom.append(toolbar, $('span.thrice-chart-title'));
	title.textContent = spec.title;

	const expand = dom.append(toolbar, $('button.thrice-chart-expand'));
	expand.setAttribute('type', 'button');
	expand.textContent = localize('thriceChart.expand', "Expand");
	expand.addEventListener('click', () => {
		const expanded = root.classList.toggle('is-expanded');
		expand.textContent = expanded
			? localize('thriceChart.collapse', "Collapse")
			: localize('thriceChart.expand', "Expand");
	});

	const exportButton = dom.append(toolbar, $('button.thrice-chart-export'));
	exportButton.setAttribute('type', 'button');
	exportButton.textContent = localize('thriceChart.export', "Export");
	exportButton.addEventListener('click', () => downloadSpec(root, spec));

	const plot = dom.append(root, $('.thrice-chart-plot'));
	const max = Math.max(...spec.series.map(item => Math.abs(item.value)), 1);
	for (const item of spec.series) {
		const row = dom.append(plot, $('.thrice-chart-row'));
		const name = dom.append(row, $('span.thrice-chart-name'));
		name.textContent = item.name;
		const track = dom.append(row, $('span.thrice-chart-track'));
		const bar = dom.append(track, $('span.thrice-chart-bar'));
		bar.style.width = `${Math.round((Math.abs(item.value) / max) * 100)}%`;
		const value = dom.append(row, $('span.thrice-chart-value'));
		value.textContent = String(item.value);
	}
	return root;
}

function downloadSpec(root: HTMLElement, spec: ThriceChartSpec): void {
	const document = root.ownerDocument;
	const blob = new Blob([JSON.stringify(spec, undefined, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = `${spec.title.replace(/[^\w.-]+/g, '-') || 'chart'}.json`;
	link.click();
	dom.getWindow(root).setTimeout(() => URL.revokeObjectURL(url), 1000);
}
