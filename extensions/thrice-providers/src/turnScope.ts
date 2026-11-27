/*---------------------------------------------------------------------------------------------
 *  Which changed files belong to which agent turn.
 *
 *  A turn's end-of-turn sweep diffs the whole repo between its start and end snapshots. That
 *  catches files the agent changed without reporting them (shell commands, code generators), but
 *  also everything else that changed meanwhile: another chat's agent, the user saving a file, a
 *  formatter. `TurnScopes` tracks the turns running in each repo so the sweep only keeps files it
 *  can attribute to its own agent.
 *--------------------------------------------------------------------------------------------*/

/** Why the sweep kept or dropped a changed file. */
export type Attribution =
	| "reported" // this turn's agent reported editing it
	| "unreported" // not reported, but this turn ran alone and nothing else touched it
	| "otherTurn" // another turn running in the same repo reported it
	| "userSaved" // the user saved it in an editor during the turn
	| "concurrent"; // not reported, and another turn ran in the repo at some point during this one

export class TurnScope {
	private readonly reported = new Set<string>();
	/** Files other turns in the repo reported while this one ran. */
	readonly foreign = new Set<string>();
	/** Files the user saved in an editor while this turn ran. */
	readonly saved = new Set<string>();
	/** Whether any other turn ran in the same repo at any point during this one. */
	overlapped = false;
	private ended = false;
	/** Repo root, with no trailing slash; paths are compared under it. */
	readonly root: string;
	private readonly registry: TurnScopes;

	constructor(root: string, registry: TurnScopes) {
		this.root = root;
		this.registry = registry;
	}

	/** Records that this turn's agent edited `file` (absolute). */
	report(file: string): void {
		if (this.ended) {
			return;
		}
		this.reported.add(file);
		this.registry.reported(this, file);
	}

	isReported(file: string): boolean {
		return this.reported.has(file);
	}

	/** Whether the sweep should record `file` (absolute, under `root`) into this turn. */
	attribute(file: string): Attribution {
		if (this.reported.has(file)) {
			return "reported";
		}
		if (this.foreign.has(file)) {
			return "otherTurn";
		}
		if (this.saved.has(file)) {
			return "userSaved";
		}
		return this.overlapped ? "concurrent" : "unreported";
	}

	/** Stops tracking. Later reports and saves are ignored; the sets keep what they hold. */
	end(): void {
		if (!this.ended) {
			this.ended = true;
			this.registry.ended(this);
		}
	}
}

/** The turns running in each repo. */
export class TurnScopes {
	private readonly active = new Map<string, Set<TurnScope>>();

	/** Starts tracking a turn in the repo at `root`. */
	begin(root: string): TurnScope {
		const key = trimSlash(root);
		const scope = new TurnScope(key, this);
		let turns = this.active.get(key);
		if (!turns) {
			turns = new Set();
			this.active.set(key, turns);
		}
		if (turns.size) {
			scope.overlapped = true;
			for (const other of turns) {
				other.overlapped = true;
			}
		}
		turns.add(scope);
		return scope;
	}

	/** Records that the user saved `file` (absolute) in an editor. */
	saved(file: string): void {
		for (const [root, turns] of this.active) {
			if (isUnder(file, root)) {
				for (const turn of turns) {
					turn.saved.add(file);
				}
			}
		}
	}

	/** @internal Called by {@link TurnScope.report}. */
	reported(from: TurnScope, file: string): void {
		for (const turn of this.active.get(from.root) ?? []) {
			if (turn !== from) {
				turn.foreign.add(file);
			}
		}
	}

	/** @internal Called by {@link TurnScope.end}. */
	ended(scope: TurnScope): void {
		const turns = this.active.get(scope.root);
		turns?.delete(scope);
		if (turns && !turns.size) {
			this.active.delete(scope.root);
		}
	}

	/** Turns running now in the repo at `root`. */
	running(root: string): number {
		return this.active.get(trimSlash(root))?.size ?? 0;
	}
}

function trimSlash(path: string): string {
	return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function isUnder(file: string, root: string): boolean {
	return file.startsWith(`${root}/`);
}
