/**
 * Steering: when the user sends a message while a turn runs, the chat sets `ChatContext.yieldRequested`
 * on the running request and holds the new message until that request ends. The API has no event for
 * the flag, so it is polled; once set, `onYield` runs (the participant interrupts the CLI turn, which
 * keeps the CLI session) and the steering message is sent right away instead of after the turn.
 */
export interface YieldWatch {
	/** True once a yield was requested and `onYield` ran. */
	readonly yielded: boolean;
	dispose(): void;
}

export const YIELD_POLL_MS = 150;

export function watchYield(
	isRequested: () => boolean,
	onYield: () => void,
	intervalMs = YIELD_POLL_MS,
): YieldWatch {
	let yielded = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	const stop = () => {
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	};
	const check = () => {
		if (yielded || !isRequested()) {
			return;
		}
		yielded = true;
		stop();
		onYield();
	};
	timer = setInterval(check, intervalMs);
	check();
	return {
		get yielded() {
			return yielded;
		},
		dispose: stop,
	};
}
