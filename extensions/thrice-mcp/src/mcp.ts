export function prepareAuthorization(): { ok: false; reason: 'redirect-unconfirmed' } {
	return { ok: false, reason: 'redirect-unconfirmed' };
}

export function callTool(): { ok: false; reason: 'arguments-unknown' } {
	return { ok: false, reason: 'arguments-unknown' };
}

export function handleUri(_uri: string): { ok: false; reason: 'uri-grammar-unconfirmed' } {
	return { ok: false, reason: 'uri-grammar-unconfirmed' };
}
