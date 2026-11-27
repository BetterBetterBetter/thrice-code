export interface ThriceChartSeries {
	readonly name: string;
	readonly value: number;
}

export interface ThriceChartSpec {
	readonly title: string;
	readonly series: readonly ThriceChartSeries[];
}

export function parseThriceChart(text: string): { spec: ThriceChartSpec } | { error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { error: 'This chart is not valid JSON.' };
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { error: 'This chart needs a title and a series.' };
	}
	const record = parsed as { title?: unknown; series?: unknown };
	if (typeof record.title !== 'string' || record.title.trim().length === 0) {
		return { error: 'This chart needs a title.' };
	}
	if (!Array.isArray(record.series) || record.series.length === 0) {
		return { error: 'This chart needs a series.' };
	}
	const series: ThriceChartSeries[] = [];
	for (const item of record.series) {
		if (!item || typeof item !== 'object') {
			return { error: 'Each series item needs a name and a numeric value.' };
		}
		const row = item as { name?: unknown; value?: unknown };
		if (typeof row.name !== 'string' || row.name.trim().length === 0 || typeof row.value !== 'number' || !Number.isFinite(row.value)) {
			return { error: 'Each series item needs a name and a numeric value.' };
		}
		series.push({ name: row.name, value: row.value });
	}
	return { spec: { title: record.title.trim(), series } };
}
