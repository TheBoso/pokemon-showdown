/**
 * Adventure - campaign registry
 *
 * A campaign is one playable game: Emerald, FireRed, Platinum. Everything
 * game-specific lives in `data/campaigns/<id>/` as data, never in engine code,
 * so adding a new game is a folder and a scraper profile rather than a patch.
 *
 * The engine knows about *campaigns*. It does not know about Emerald.
 *
 * Layout:
 *
 *   data/campaigns/emerald/
 *     manifest.json       required - identity, starters, starting conditions
 *     locations.json      the map graph
 *     trainers.json       trainer rosters as Showdown sets
 *     encounters.json     wild encounter tables
 *     species-extra.json  catch rate, base EXP, growth rate
 *
 * Only the manifest is required. The bulk data files arrive per milestone and
 * are loaded lazily, so a campaign is usable before it is complete.
 */

import { FS } from '../../lib';

const CAMPAIGN_DIR = 'data/campaigns';

/** A map with more problems than this is broken in a way a log dump won't help with. */
const MAX_REPORTED_PROBLEMS = 20;

export interface StarterOption {
	species: string;
	type: string;
	blurb: string;
}

export interface CampaignManifest {
	id: string;
	name: string;
	region: string;
	generation: number;
	/** The Showdown mod battles are run under, e.g. 'gen3'. */
	mod: string;

	startLocation: string;
	startMoney: number;
	starterLevel: number;
	starters: StarterOption[];

	maxPartySize: number;
	maxMoves: number;
	/** Denominator of the shiny chance: 8192 in gen 3. */
	shinyRate: number;

	data: {
		locations?: string,
		trainers?: string,
		encounters?: string,
		speciesExtra?: string,
	};
}

/* ------------------------------------------------------------------ *
 * Bulk data shapes
 * ------------------------------------------------------------------ */

export type LocationKind = 'town' | 'city' | 'route' | 'water' | 'forest' | 'cave' | 'building';

/**
 * A gate on travelling *into* a location, as a list of requirement tokens.
 *
 * Tokens are `type:value`:
 *
 *   badge:stone     the Stone Badge, i.e. Rustboro's gym
 *   hm:surf         the party can use Surf outside battle
 *   item:devonscope the party holds a key item
 *   flag:magma_hideout_cleared   a story beat has happened
 *
 * All tokens must be satisfied. This is the pacing dial for the whole
 * adventure: it is what stops a level 5 party wandering to Ever Grande.
 */
export type Requirement = string;

/**
 * One edge out of a location.
 *
 * Requirements live on the *edge*, not the destination, because the same place
 * is often reachable by an open road and a gated one. Route 110 is the example
 * that forced this: you walk in from Slateport with nothing, but the link from
 * Route 103 is open water and needs Surf. Gating the destination would either
 * lock Slateport's road or leave a level-5 party able to swim to Mauville.
 */
export interface Connection {
	to: string;
	requires?: Requirement[];
	notes?: string;
}

export interface LocationData {
	name: string;
	kind: LocationKind;
	/**
	 * Where you can go from here, as a plain id or `{to, requires}`.
	 *
	 * Connections are declared in both directions; `validateLocations` rejects
	 * one-sided links, because a route you can enter and not leave is always a
	 * mistake rather than a design choice. The two directions may carry
	 * different requirements - a ledge you can hop down but not climb back up.
	 */
	connections: (string | Connection)[];
	/** Key into encounters.json, when the location has wild Pokemon. */
	encounters?: string;
	/** Trainer ids, in gauntlet order. */
	trainers?: string[];
	pokecenter?: boolean;
	pokemart?: string[];
	/** Gym leader id, for locations that hold a badge. */
	gym?: string;
	/** Badge awarded by this location's gym. */
	badge?: string;
	/**
	 * Gate on challenging the gym, separate from entering the town.
	 * Petalburg is the reason this exists: you walk through it in the first
	 * ten minutes but cannot fight Norman until you hold four badges.
	 */
	gymRequires?: Requirement[];
	requires?: Requirement[];
	/** Author's note; ignored by the engine. */
	notes?: string;
}

export type LocationMap = { [id: string]: LocationData };

/** Reads a location's edges in a single shape, whichever form they were written in. */
export function exitsOf(location: LocationData): Connection[] {
	return (location.connections || []).map(
		entry => (typeof entry === 'string' ? { to: entry } : entry)
	);
}

const VALID_KINDS: LocationKind[] = ['town', 'city', 'route', 'water', 'forest', 'cave', 'building'];
const VALID_REQUIREMENT_TYPES = ['badge', 'hm', 'item', 'flag'];

export interface LocationProblem {
	location: string;
	problem: string;
}

/**
 * Checks a location graph for the mistakes that are easy to make by hand and
 * impossible to spot by eye: dangling connections, one-way links, unreachable
 * regions, bad enum values.
 *
 * Returns every problem rather than throwing on the first, so a broken map can
 * be fixed in one pass instead of ten.
 */
export function validateLocations(locations: LocationMap, startLocation: string): LocationProblem[] {
	const problems: LocationProblem[] = [];
	const ids = new Set(Object.keys(locations));

	for (const [id, location] of Object.entries(locations)) {
		if (toID(id) !== id) {
			problems.push({ location: id, problem: `id is not a valid ID (lowercase alphanumeric)` });
		}
		if (!location.name) {
			problems.push({ location: id, problem: `missing name` });
		}
		if (!VALID_KINDS.includes(location.kind)) {
			problems.push({ location: id, problem: `unknown kind "${location.kind}"` });
		}
		if (!Array.isArray(location.connections)) {
			problems.push({ location: id, problem: `connections must be an array` });
			continue;
		}

		const seen = new Set<string>();
		const edges = exitsOf(location);
		for (const edge of edges) {
			const target = edge.to;
			if (target === id) {
				problems.push({ location: id, problem: `connects to itself` });
			} else if (seen.has(target)) {
				problems.push({ location: id, problem: `lists "${target}" twice` });
			} else if (!ids.has(target)) {
				problems.push({ location: id, problem: `connects to unknown location "${target}"` });
			} else if (!exitsOf(locations[target]).some(back => back.to === id)) {
				problems.push({ location: id, problem: `one-way link to "${target}" (not mirrored back)` });
			}
			seen.add(target);
		}

		const edgeRequirements = edges.flatMap(edge => edge.requires || []);
		for (const requirement of [
			...location.requires || [], ...location.gymRequires || [], ...edgeRequirements,
		]) {
			const [type, value] = requirement.split(':');
			if (!VALID_REQUIREMENT_TYPES.includes(type) || !value) {
				problems.push({
					location: id,
					problem: `malformed requirement "${requirement}" ` +
						`(expected one of ${VALID_REQUIREMENT_TYPES.join('/')}:value)`,
				});
			}
		}

		if (location.gymRequires && !location.gym) {
			problems.push({ location: id, problem: `has gymRequires but no gym` });
		}
		if (location.gym && !location.badge) {
			problems.push({ location: id, problem: `has a gym but no badge` });
		}
	}

	if (!ids.has(startLocation)) {
		problems.push({ location: startLocation, problem: `startLocation is not in the map` });
		return problems;
	}

	// Anything the player can never walk to is dead data, and almost always a
	// typo in a connection rather than an intentional island.
	const reachable = new Set<string>([startLocation]);
	const queue = [startLocation];
	while (queue.length) {
		for (const edge of exitsOf(locations[queue.shift()!])) {
			if (!ids.has(edge.to) || reachable.has(edge.to)) continue;
			reachable.add(edge.to);
			queue.push(edge.to);
		}
	}
	for (const id of ids) {
		if (!reachable.has(id)) {
			problems.push({ location: id, problem: `unreachable from ${startLocation}` });
		}
	}

	return problems;
}

/** One Pokemon on a trainer's team, as a Showdown set. */
export interface TrainerMon {
	species: string;
	level: number;
	ivs: StatsTable;
	evs: StatsTable;
	item: string;
	ability: string;
	nature: string;
	moves: string[];
}

export interface TrainerData {
	name: string;
	trainerClass: string;
	team: TrainerMon[];
	doubleBattle?: boolean;
	/** Emerald's AI script flags, for faithful behaviour later. */
	ai?: string[];
	/** Bag items the AI uses mid-battle. Recorded, not yet simulated. */
	items?: string[];
}

/** The shape of the generated trainers.json. */
export interface TrainerFile {
	trainers: { [id: string]: TrainerData };
	byLocation: { [locationId: string]: string[] };
}

export interface EncounterEntry {
	species: string;
	minLevel: number;
	maxLevel: number;
	/** Relative weight within its method. */
	rate: number;
}

export interface EncounterTable {
	[method: string]: EncounterEntry[];
}

export interface SpeciesExtra {
	catchRate: number;
	baseExp: number;
	growthRate: string;
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

const REQUIRED_FIELDS: (keyof CampaignManifest)[] = [
	'id', 'name', 'mod', 'startLocation', 'starters',
];

function validate(manifest: AnyObject, dir: string): CampaignManifest | null {
	for (const field of REQUIRED_FIELDS) {
		if (manifest[field] === undefined) {
			Monitor.error(`Campaign ${dir} is missing required field "${field}"; skipping.`);
			return null;
		}
	}
	if (!Array.isArray(manifest.starters) || !manifest.starters.length) {
		Monitor.error(`Campaign ${dir} has no starters; skipping.`);
		return null;
	}
	try {
		// Throws if the mod doesn't exist. Cheap: mods are loaded lazily anyway.
		Dex.mod(manifest.mod);
	} catch {
		Monitor.error(`Campaign ${dir} wants unknown mod "${manifest.mod}"; skipping.`);
		return null;
	}

	// Defaults, so a minimal manifest is still valid.
	return {
		region: '',
		generation: 0,
		startMoney: 0,
		starterLevel: 5,
		maxPartySize: 6,
		maxMoves: 4,
		shinyRate: 8192,
		data: {},
		...manifest,
	} as CampaignManifest;
}

export class Campaign {
	readonly manifest: CampaignManifest;
	readonly dir: string;
	/** Bulk data is loaded on first use, not at boot. */
	private cache = new Map<string, any>();

	constructor(manifest: CampaignManifest, dir: string) {
		this.manifest = manifest;
		this.dir = dir;
	}

	get id() { return this.manifest.id; }
	get name() { return this.manifest.name; }
	get mod() { return this.manifest.mod; }

	/**
	 * Reads one of the campaign's data files.
	 *
	 * Returns null when the file isn't there yet - a campaign is playable
	 * before every table has been generated, and callers are expected to
	 * degrade rather than crash.
	 */
	private load<T>(key: keyof CampaignManifest['data']): T | null {
		if (this.cache.has(key)) return this.cache.get(key);

		const filename = this.manifest.data[key];
		if (!filename) {
			this.cache.set(key, null);
			return null;
		}

		const raw = FS(`${this.dir}/${filename}`).readIfExistsSync();
		if (!raw) {
			this.cache.set(key, null);
			return null;
		}

		let parsed: T | null = null;
		try {
			parsed = JSON.parse(raw);
		} catch (err: any) {
			Monitor.error(`Campaign ${this.id}: ${filename} is not valid JSON (${err.message}).`);
		}
		this.cache.set(key, parsed);
		return parsed;
	}

	locations(): LocationMap | null {
		const raw = this.load<LocationMap>('locations');
		if (!raw) return null;
		if (!this.cache.has('locations:clean')) {
			// Keys starting with `_` are file-level notes for whoever maintains
			// the map by hand, not places you can walk to.
			const clean: LocationMap = {};
			for (const [id, location] of Object.entries(raw)) {
				if (!id.startsWith('_')) clean[id] = location;
			}
			this.cache.set('locations:clean', clean);

			// A hand-authored map fails silently by nature: a mistyped
			// connection is just a road that quietly is not there. Complain
			// once, on first load, rather than never.
			const problems = validateLocations(clean, this.manifest.startLocation);
			for (const problem of problems.slice(0, MAX_REPORTED_PROBLEMS)) {
				Monitor.error(`Campaign ${this.id} map: ${problem.location}: ${problem.problem}`);
			}
			if (problems.length > MAX_REPORTED_PROBLEMS) {
				Monitor.error(
					`Campaign ${this.id} map: ...and ${problems.length - MAX_REPORTED_PROBLEMS} more problems.`
				);
			}
		}
		return this.cache.get('locations:clean');
	}

	location(id: string): LocationData | null {
		return this.locations()?.[id] || null;
	}

	/** Display name for a location id, falling back to the raw id. */
	locationName(id: string): string {
		return this.location(id)?.name || id;
	}

	/**
	 * Where you can travel from `id`, in declaration order.
	 *
	 * Requirement gating is *not* applied here - the caller decides whether to
	 * hide locked destinations or show them greyed out, and it is friendlier to
	 * show a locked road than to pretend it does not exist.
	 */
	exits(id: string): { id: string, location: LocationData, requires: Requirement[] }[] {
		const locations = this.locations();
		if (!locations?.[id]) return [];
		return exitsOf(locations[id])
			.filter(edge => locations[edge.to])
			.map(edge => ({
				id: edge.to,
				location: locations[edge.to],
				// Entering a place can be gated by the road *and* by the place
				// itself; the player has to satisfy both.
				requires: [...edge.requires || [], ...locations[edge.to].requires || []],
			}));
	}

	/** Problems with this campaign's map, or [] if it is sound or absent. */
	validateLocations(): LocationProblem[] {
		const locations = this.locations();
		if (!locations) return [];
		return validateLocations(locations, this.manifest.startLocation);
	}

	private trainerFile(): TrainerFile | null {
		return this.load<TrainerFile>('trainers');
	}

	trainers(): { [id: string]: TrainerData } | null {
		return this.trainerFile()?.trainers || null;
	}

	trainer(id: string): TrainerData | null {
		return this.trainers()?.[id] || null;
	}

	/**
	 * The trainers standing at a location, in the order the ROM lists them.
	 *
	 * A location's own `trainers` array overrides the generated index, so a
	 * campaign can hand-order a gauntlet where the ROM's order reads badly.
	 */
	trainersAt(locationId: string): { id: string, trainer: TrainerData }[] {
		const override = this.location(locationId)?.trainers;
		const ids = override || this.trainerFile()?.byLocation?.[locationId] || [];
		const trainers = this.trainers() || {};
		return ids
			.filter(id => trainers[id])
			.map(id => ({ id, trainer: trainers[id] }));
	}

	encounters(): { [table: string]: EncounterTable } | null {
		return this.load('encounters');
	}

	encounterTable(id: string): EncounterTable | null {
		return this.encounters()?.[id] || null;
	}

	speciesExtra(): { [speciesid: string]: SpeciesExtra } | null {
		return this.load('speciesExtra');
	}

	/** Catch rate, base EXP and growth curve - none of which Showdown's dex carries. */
	extraFor(species: string): SpeciesExtra | null {
		return this.speciesExtra()?.[toID(species)] || null;
	}

	/** Drops cached data so regenerated files can be picked up without a restart. */
	reload(): void {
		this.cache.clear();
	}
}

const campaigns = new Map<string, Campaign>();

function loadCampaigns(): void {
	campaigns.clear();

	let dirs: string[];
	try {
		dirs = FS(CAMPAIGN_DIR).readdirSync();
	} catch {
		return; // no campaigns installed
	}

	for (const entry of dirs) {
		const dir = `${CAMPAIGN_DIR}/${entry}`;
		if (!FS(dir).isDirectorySync()) continue;

		const raw = FS(`${dir}/manifest.json`).readIfExistsSync();
		if (!raw) continue;

		let parsed: AnyObject;
		try {
			parsed = JSON.parse(raw);
		} catch (err: any) {
			Monitor.error(`Campaign ${dir}: manifest.json is not valid JSON (${err.message}); skipping.`);
			continue;
		}

		const manifest = validate(parsed, dir);
		if (!manifest) continue;
		campaigns.set(toID(manifest.id), new Campaign(manifest, dir));
	}
}

loadCampaigns();

export function getCampaign(id: string): Campaign | null {
	return campaigns.get(toID(id)) || null;
}

export function allCampaigns(): Campaign[] {
	return [...campaigns.values()];
}

export function campaignNames(): string {
	const names = allCampaigns().map(campaign => campaign.id);
	return names.length ? names.join(', ') : '(none installed)';
}

/** Re-reads every manifest from disk. Exposed for the reload command. */
export function reloadCampaigns(): void {
	loadCampaigns();
}
