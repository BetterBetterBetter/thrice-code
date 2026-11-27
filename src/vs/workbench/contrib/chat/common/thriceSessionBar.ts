export interface ThriceSessionBarState {
	readonly missingFolder: boolean;
	readonly branch: string | undefined;
	/** Commits ahead of / behind the upstream, when known. */
	readonly ahead?: number;
	readonly behind?: number;
}

export interface ThriceSessionBarDescription {
	missing: boolean;
	branch: string | undefined;
	/** Ahead/behind badge (up arrow + ahead, down arrow + behind); undefined when in sync or unknown. */
	sync: string | undefined;
	showPullRequest: boolean;
	showChanges: boolean;
}

export function describeSessionBar(state: ThriceSessionBarState): ThriceSessionBarDescription {
	const sync = [state.ahead ? `\u2191${state.ahead}` : '', state.behind ? `\u2193${state.behind}` : ''].filter(Boolean).join(' ');
	return {
		missing: state.missingFolder,
		branch: state.branch,
		sync: state.branch && sync ? sync : undefined,
		showPullRequest: !!state.branch && !state.missingFolder,
		showChanges: !!state.branch && !state.missingFolder,
	};
}
