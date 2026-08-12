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
 * Adventures run for hours and outlive deploys, so an upgrade that silently
 * binned everyone's save would be the worst kind of bug. Each step migrates
 * one version forward and falls through to the next.
 */
function migrate(state: AdventureState): AdventureState | null {
	// From a newer server than this one; leave it alone rather than mangle it.
	if (state.version > STATE_VERSION) return null;

	if (state.version === 1) {
		// v2 moved badges from each player onto shared group progress, and
		// added HMs, key items and story flags alongside them.
		const anyState = state as AnyObject;
		const badges = new Set<string>();
		const players: AnyObject[] = Object.values(anyState.players || {});
		for (const player of players) {
			for (const badge of player.badges || []) badges.add(badge);
			delete player.badges;
		}
		anyState.progress = { badges: [...badges], hms: [], keyItems: [], flags: [] };
		state.version = 2;
	}

	if (state.version === 2) {
		// v3 tracks where the party walked in from, so a route's gauntlet can
		// lock the way onward while leaving the way back open. An adventure
		// mid-route when the server restarted simply has no retreat recorded.
		(state as AnyObject).cameFrom = '';
		state.version = 3;
	}

	return state.version === STATE_VERSION ? state : null;
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
