/**
 * Databricks Connect version reconciliation — the pure decisions the connect flow
 * drives on (`src/lib/server/dbrVersion.ts`).
 *
 * Databricks Connect requires the CLIENT version to be ≤ the target cluster's
 * Databricks Runtime; a newer client hard-fails the session ("Unsupported
 * combination of Databricks Runtime & Databricks Connect versions"). The fix pins
 * `databricks-connect` to the cluster's DBR major.minor line. These are the pure
 * halves of that fix: parsing a cluster's `spark_version` into a pin target,
 * deciding whether a reinstall is needed, and — the safety net — recognizing and
 * explaining a mismatch that still slips through. No kernel, venv, or SDK needed.
 */
import { describe, it, expect } from 'vitest';
import {
	dbrMajorMinor,
	connectMajorMinor,
	pinTargetForConnect,
	parseVersionMismatch,
	versionMismatchMessage
} from '../../src/lib/server/dbrVersion';

describe('dbrMajorMinor', () => {
	it('extracts major.minor from classic DBR spark_version variants', () => {
		expect(dbrMajorMinor('17.3.x-scala2.12')).toBe('17.3');
		expect(dbrMajorMinor('15.4.x-photon-scala2.12')).toBe('15.4');
		expect(dbrMajorMinor('13.3.x-cpu-ml-scala2.12')).toBe('13.3');
		expect(dbrMajorMinor('14.3.x-aarch64-scala2.12')).toBe('14.3');
		expect(dbrMajorMinor('  16.1.x-scala2.12  ')).toBe('16.1');
	});

	it('returns null for non-classic / unpinnable runtimes', () => {
		// Serverless / warehouse markers and custom images carry no classic DBR line.
		expect(dbrMajorMinor('custom:my-image')).toBeNull();
		expect(dbrMajorMinor('client.1')).toBeNull(); // serverless-style marker
		expect(dbrMajorMinor('')).toBeNull();
		expect(dbrMajorMinor(null)).toBeNull();
		expect(dbrMajorMinor(undefined)).toBeNull();
		// A bare "17.3" with no trailing dot is not a runtime string; require the tail.
		expect(dbrMajorMinor('17.3')).toBeNull();
	});
});

describe('connectMajorMinor', () => {
	it('reduces a full client version to major.minor', () => {
		expect(connectMajorMinor('18.3.2')).toBe('18.3');
		expect(connectMajorMinor('17.3.12')).toBe('17.3');
		expect(connectMajorMinor('15.4')).toBe('15.4');
	});
	it('returns null for absent/unparseable versions', () => {
		expect(connectMajorMinor(null)).toBeNull();
		expect(connectMajorMinor(undefined)).toBeNull();
		expect(connectMajorMinor('')).toBeNull();
		expect(connectMajorMinor('unknown')).toBeNull();
	});
});

describe('pinTargetForConnect', () => {
	it('pins to the DBR line when the installed client is NEWER (the captain’s case)', () => {
		// DBR 17.3 cluster, latest client 18.3.2 installed → pin to 17.3.
		expect(pinTargetForConnect('17.3', '18.3.2')).toBe('17.3');
	});
	it('leaves a client that is TOO OLD for the cluster untouched (asymmetric)', () => {
		// A client ≤ the runtime connects fine, so no reinstall / kernel restart.
		expect(pinTargetForConnect('17.3', '15.4.1')).toBeNull();
	});
	it('compares major.minor numerically, not lexically', () => {
		// 17.10 is NEWER than 17.3 (10 > 3), so it must be re-pinned.
		expect(pinTargetForConnect('17.3', '17.10.0')).toBe('17.3');
		// 17.3 is OLDER than 17.10 (3 < 10), so it is left alone.
		expect(pinTargetForConnect('17.10', '17.3.0')).toBeNull();
	});
	it('is a no-op when the installed client already matches the DBR line', () => {
		expect(pinTargetForConnect('17.3', '17.3.12')).toBeNull();
		expect(pinTargetForConnect('17.3', '17.3')).toBeNull();
	});
	it('never guesses a pin when the DBR is unknown (serverless / unresolvable)', () => {
		expect(pinTargetForConnect(null, '18.3.2')).toBeNull();
		expect(pinTargetForConnect(undefined, '18.3.2')).toBeNull();
	});
	it('leaves an unparseable installed version untouched (never a forced reinstall loop)', () => {
		expect(pinTargetForConnect('17.3', null)).toBeNull();
		expect(pinTargetForConnect('17.3', 'unknown')).toBeNull();
	});
});

describe('parseVersionMismatch', () => {
	it('parses the exact SDK error the captain hit', () => {
		const raw =
			'Exception: Unsupported combination of Databricks Runtime & Databricks Connect versions: ' +
			'17.3 (Databricks Runtime) < 18.3.2 (Databricks Connect).';
		expect(parseVersionMismatch(raw)).toEqual({ runtime: '17.3', client: '18.3.2' });
	});

	it('tolerates newlines and surrounding whitespace (exception repr wrapping)', () => {
		const raw =
			'Unsupported combination of Databricks Runtime & Databricks Connect versions:\n' +
			'  15.4 (Databricks Runtime)  <  16.1.0 (Databricks Connect).\n';
		expect(parseVersionMismatch(raw)).toEqual({ runtime: '15.4', client: '16.1.0' });
	});

	it('returns null for unrelated errors and non-strings', () => {
		expect(parseVersionMismatch('PermissionDenied: cluster not accessible')).toBeNull();
		expect(parseVersionMismatch('')).toBeNull();
		expect(parseVersionMismatch(null)).toBeNull();
		expect(parseVersionMismatch(undefined)).toBeNull();
	});
});

describe('versionMismatchMessage', () => {
	it('names both versions and the exact pin command, and reflects that Cellar self-heals', () => {
		const msg = versionMismatchMessage({ runtime: '17.3', client: '18.3.2' });
		expect(msg).toContain('18.3.2');
		expect(msg).toContain('DBR 17.3');
		expect(msg).toContain('databricks-connect==17.3.*');
		expect(msg.toLowerCase()).toContain('cellar');
	});
});
