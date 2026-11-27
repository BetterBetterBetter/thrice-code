export const PORT_MIN = 7242;
export const PORT_MAX = 7942;
export const DEFAULT_BIND = '127.0.0.1';
export const PORT_IN_USE = 'Port is already in use';
export const CHANGE_PORT = 'Change Port';
export const KNOWN_METHODS = ['POST', 'OPTIONS', 'get'] as const;

export type PortCollision = { error: typeof PORT_IN_USE; action: typeof CHANGE_PORT };
export type Ingest = { state: 'stopped' } | { state: 'listening'; port: number; bindAddress: string };

export function resolveListenPort(configured: number, isTaken: (port: number) => boolean): number | PortCollision {
	const collision: PortCollision = { error: PORT_IN_USE, action: CHANGE_PORT };
	if (configured !== 0) {
		return isTaken(configured) ? collision : configured;
	}
	for (let port = PORT_MIN; port <= PORT_MAX; port++) {
		if (!isTaken(port)) {
			return port;
		}
	}
	return collision;
}

export function createIngest(): Ingest {
	return { state: 'stopped' };
}

export function start(_current: Ingest, options: { port: number; bindAddress: string }): Ingest {
	return { state: 'listening', port: options.port, bindAddress: options.bindAddress };
}

export function stop(_current: Ingest): Ingest {
	return { state: 'stopped' };
}

export function reassignPort(current: Ingest, port: number): Ingest {
	const bindAddress = current.state === 'listening' ? current.bindAddress : DEFAULT_BIND;
	return start(stop(current), { port, bindAddress });
}

export function handleRequest(_request: { method: string }): { accepted: false; reason: 'path-unknown' } {
	return { accepted: false, reason: 'path-unknown' };
}
