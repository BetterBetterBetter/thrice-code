export const TRANSIENT_ERROR = 'CursorSocketTransient';

export type Transport = 'tcp' | 'tls';

export type Lease = {
	transport: Transport;
	state: 'created' | 'acquired' | 'released' | 'failed';
	connections: string[];
	shutdownScheduled: boolean;
	errorName?: string;
};

export type TransportError = { ok: false; reason: 'unknown-transport' };

export function createLease(transport: string): Lease | TransportError {
	if (transport !== 'tcp' && transport !== 'tls') {
		return { ok: false, reason: 'unknown-transport' };
	}
	return {
		transport,
		state: 'created',
		connections: [],
		shutdownScheduled: false,
	};
}

export function acquireLease(lease: Lease): Lease {
	return { ...lease, state: 'acquired' };
}

export function releaseLease(lease: Lease): Lease {
	return { ...lease, state: 'released', connections: [] };
}

export function closeConnectionFromLease(lease: Lease): Lease {
	return { ...lease, connections: [] };
}

export function scheduleShutdownIfUnowned(lease: Lease): Lease {
	if (lease.state !== 'created') {
		return { ...lease, shutdownScheduled: false };
	}
	return { ...lease, shutdownScheduled: true };
}

export function cancelShutdownTimer(lease: Lease): Lease {
	return { ...lease, shutdownScheduled: false };
}

export function injectFailure(lease: Lease): Lease {
	return { ...lease, state: 'failed', errorName: TRANSIENT_ERROR };
}

export function isClosed(lease: Lease): boolean {
	return lease.state === 'released' || lease.state === 'failed';
}

export function writeFromLease(lease: Lease, _bytes: string): { ok: true } | { ok: false; reason: 'closed' } {
	if (lease.state !== 'acquired') {
		return { ok: false, reason: 'closed' };
	}
	return { ok: true };
}
