export function openSession(): { state: 'open' } {
	return { state: 'open' };
}

export function callTool(_session: { state: 'open' }): { ok: false; reason: 'arguments-unknown' } {
	return { ok: false, reason: 'arguments-unknown' };
}

export function screenshot(): { ok: false; reason: 'image-unknown' } {
	return { ok: false, reason: 'image-unknown' };
}
