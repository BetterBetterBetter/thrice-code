import type { Driver } from './instances';
import { createEventDecoder } from './events';

/** Text-only view of the typed decoder in `events.ts`, for callers that only show answer text. */
export interface TextDecoder {
	push(line: string): string[];
	failure(): string | undefined;
}

export function createDecoder(driver: Driver): TextDecoder {
	const decoder = createEventDecoder(driver);
	return {
		push(line) {
			const texts: string[] = [];
			for (const event of decoder.push(line)) {
				if (event.kind === 'text') {
					texts.push(event.text);
				}
			}
			return texts;
		},
		failure: () => decoder.failure(),
	};
}
