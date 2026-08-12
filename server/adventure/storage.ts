/**
 * Adventure - persistence
 *
 * Playthroughs are long. An adventure room can easily outlive a server
 * restart, and losing one to a deploy would be miserable, so state is written
 * to disk after every phase transition and reloaded on boot.
 *
 * Writes go through `FS#writeUpdate`, which throttles and coalesces them, so
 * saving on every mutation is cheap enough not to think about.
 */

import { FS } from '../../lib';
import { STATE_VERSION, type AdventureState } from './state';

const SAVE_FILE = 'databases/adventures.json';

interface SaveFile {
	version: number;
	adventures: { [roomid: string]: AdventureState };
}

let saved: SaveFile = { version: STATE_VERSION, adventures: {} };

/**
 * Brings an older on-disk adventure up to the current shape.
 *
 * There is nothing to migrate yet - v1 is the first version - but adventures
 * are long-lived enough that the seam needs to exist before it is needed
 * rather than after.
 */
function migrate(state: AdventureState): AdventureState | null {
	if (state.version === STATE_VERSION) return state;
	if (state.version > STATE_VERSION) return null; // from a newer server; leave it alone
	return null;
}

function load(): void {
	const raw = FS(SAVE_FILE).readIfExistsSync();
	if (!raw) return;

	let parsed: SaveFile;
	try {
		parsed = JSON.parse(raw);
	} catch {
		Monitor.crashlog(new Error(`Corrupt ${SAVE_FILE}`), 'Adventure storage');
		return;
	}

	const migrated: { [roomid: string]: AdventureState } = {};
	for (const roomid in parsed.adventures || {}) {
		const state = migrate(parsed.adventures[roomid]);
		if (state) migrated[roomid] = state;
	}
	saved = { version: STATE_VERSION, adventures: migrated };
}

load();

function write(): void {
	FS(SAVE_FILE).writeUpdate(() => JSON.stringify(saved), { throttle: 5000 });
}

/** Writes an adventure's current state to disk. Safe to call on every mutation. */
export function saveAdventure(state: AdventureState): void {
	state.updatedAt = Date.now();
	saved.adventures[state.roomid] = state;
	write();
}

/** Forgets an adventure entirely - it ended, or its room was destroyed. */
export function deleteAdventure(roomid: RoomID): void {
	if (!saved.adventures[roomid]) return;
	delete saved.adventures[roomid];
	write();
}

export function getAdventure(roomid: RoomID): AdventureState | undefined {
	return saved.adventures[roomid];
}

/** Every stored adventure, for restoring rooms on boot. */
export function allAdventures(): AdventureState[] {
	return Object.values(saved.adventures);
}
