export type RetrievalCommand = 'debug' | 'snapshot' | 'report';

export function developerCommand(command: RetrievalCommand): { ok: false; reason: 'payload-unknown' | 'disabled' } {
	if (command === 'report') {
		return { ok: false, reason: 'disabled' };
	}
	return { ok: false, reason: 'payload-unknown' };
}
