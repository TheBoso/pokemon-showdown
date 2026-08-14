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

/**
 * One kind of Poke Ball.
 *
 * `move` is the move the campaign's mod exposes for throwing it - balls are
 * modelled as moves so a throw takes a turn inside the simulator's own turn
 * order. A ball with no `price` is not sold anywhere; that is how the Master
 * Ball stays a story reward rather than a purchase.
 */
export interface BallOption {
	id: string;
	name: string;
	move: string;
	price?: number;
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

	/** What every player starts carrying, as itemid -> count. */
	startBag?: { [itemid: string]: number };
	/** Catching gear, weakest first. */
	balls?: BallOption[];

	/** Showdown format id for a one-player-a-side trainer battle. */
	battleFormat: string;
	/** Showdown format id for two players a side. */
	multiBattleFormat: string;
	/** Showdown format id for one player against one wild Pokemon. */
	wildBattleFormat?: string;

	data: {
		locations?: string,
		trainers?: string,
		encounters?: string,
		speciesExtra?: string,
		evolutions?: string,
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
	/**
	 * Granted once every trainer here has been beaten.
	 *
	 * This is how the story items and flags that gate the map get handed out:
	 * clearing Petalburg Woods rescues Peeko, clearing Mt Chimney puts Team
	 * Magma to flight. A gym's badge is *not* listed here - that comes from
	 * beating the leader specifically, not from clearing the whole town.
	 */
	rewards?: Requirement[];
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

	/*
	 * A second pass, this time honouring the gates and handing out what each
	 * place grants once it is reached.
	 *
	 * The walk above only proves the roads join up. This proves the run can be
	 * *finished*: that no gate has its key sitting on the far side of itself.
	 * That mistake is invisible by eye on a map this size - Route 112 asks for
	 * a flag earned at the top of Mt Chimney, which is only wrong if there is
	 * no other way up - and it would strand a real run hours in.
	 */
	const held = new Set<string>();
	const opened = new Set<string>([startLocation]);
	for (let grew = true; grew;) {
		grew = false;
		for (const id of opened) {
			const place = locations[id];
			if (place.badge) held.add(`badge:${place.badge}`);
			for (const requirement of place.rewards || []) held.add(requirement);
		}
		for (const id of [...opened]) {
			for (const edge of exitsOf(locations[id])) {
				if (!ids.has(edge.to) || opened.has(edge.to)) continue;
				// Both gates, exactly as `Campaign#exits` applies them: entering
				// a place can be barred by the road and by the place itself.
				const needed = [...edge.requires || [], ...locations[edge.to].requires || []];
				if (!needed.every(requirement => held.has(requirement))) continue;
				opened.add(edge.to);
				grew = true;
			}
		}
	}
	for (const id of ids) {
		if (reachable.has(id) && !opened.has(id)) {
			problems.push({
				location: id,
				problem: `the roads reach it but the run cannot: gated behind something nothing grants`,
			});
		}
	}

	// A gym nobody can challenge is a badge nobody can earn, which usually
	// takes the rest of the run down with it - so it is worth naming outright
	// rather than leaving it to show up as an unreachable place later.
	for (const [id, location] of Object.entries(locations)) {
		for (const requirement of location.gymRequires || []) {
			if (held.has(requirement)) continue;
			problems.push({
				location: id,
				problem: `its gym asks for "${requirement}", which nothing grants`,
			});
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
	/** Share of this method's encounters, as a percentage totalling 100. */
	rate: number;
}

export interface EncounterMethod {
	/** Roughly how often a search finds anything at all, out of 100. */
	rate: number;
	slots: EncounterEntry[];
}

/** Method name (`land`, `surf`, `oldrod`, ...) -> what turns up. */
export interface EncounterTable {
	[method: string]: EncounterMethod;
}

export interface SpeciesExtra {
	/** 0-255; higher is easier to catch. */
	catchRate: number;
	baseExp: number;
	growthRate: string;
}

/**
 * One way a species can evolve, as the campaign's own game defines it.
 *
 * Showdown's dex carries evolution data, but it carries *current* data: later
 * generations moved methods around and changed levels. A campaign is a
 * specific game, so this comes from that game.
 *
 * `kind` is deliberately open: the engine applies the kinds it understands and
 * ignores the rest, so a campaign can ship methods for systems that do not
 * exist yet (stones need a shop that sells them, trading needs trading)
 * without the engine having to know about them in advance.
 */
export interface EvolutionEntry {
	kind: string;
	/** Species name to become. */
	into: string;
	/** Level to reach, for the level-triggered kinds. */
	level?: number;
	/** Item id, for stone and trade-holding kinds. */
	stone?: string;
	beauty?: number;
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
		battleFormat: 'gen3adventure',
		multiBattleFormat: 'gen3adventuremulti',
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
	/**
	 * Is this trainer the leader of this location's gym?
	 *
	 * `gym` names the leader while the roster is keyed by the specific team -
	 * `norman_1`, with `_2` upward being the post-game rematches - so the
	 * trailing number comes off before comparing. Both sides go through `toID`
	 * because the two spellings do not otherwise meet: Mossdeep's gym is
	 * `tateandliza` and its leader is `tate_and_liza_1`.
	 */
	isGymLeader(locationId: string, trainerId: string): boolean {
		const gym = this.location(locationId)?.gym;
		if (!gym) return false;
		return toID(trainerId).replace(/\d+$/, '') === toID(gym);
	}

	trainersAt(locationId: string): { id: string, trainer: TrainerData }[] {
		const override = this.location(locationId)?.trainers;
		const ids = override || this.trainerFile()?.byLocation?.[locationId] || [];
		const trainers = this.trainers() || {};
		return ids
			.filter(id => trainers[id])
			.map(id => ({ id, trainer: trainers[id] }));
	}

	encounters(): { [locationId: string]: EncounterTable } | null {
		return this.load<{ tables: { [locationId: string]: EncounterTable } }>('encounters')?.tables || null;
	}

	/** What can be found at a location, by method. */
	encounterTable(locationId: string): EncounterTable | null {
		const override = this.location(locationId)?.encounters;
		const tables = this.encounters();
		if (!tables) return null;
		return tables[locationId] || (override ? tables[override] : null) || null;
	}

	/** The methods available at a location, e.g. ['land', 'surf']. */
	encounterMethods(locationId: string): string[] {
		return Object.keys(this.encounterTable(locationId) || {});
	}

	speciesExtra(): { [speciesid: string]: SpeciesExtra } | null {
		return this.load<{ species: { [id: string]: SpeciesExtra } }>('speciesExtra')?.species || null;
	}

	/** Catch rate, base EXP and growth curve - none of which Showdown's dex carries. */
	extraFor(species: string): SpeciesExtra | null {
		return this.speciesExtra()?.[toID(species)] || null;
	}

	evolutions(): { [speciesid: string]: EvolutionEntry[] } | null {
		return this.load<{ evolutions: { [id: string]: EvolutionEntry[] } }>('evolutions')?.evolutions || null;
	}

	/** Every way this species can evolve, in the campaign's own game. */
	evolutionsFor(species: string): EvolutionEntry[] {
		return this.evolutions()?.[toID(species)] || [];
	}

	/** Every ball this game has, weakest first. */
	balls(): BallOption[] {
		return this.manifest.balls || [];
	}

	ball(itemid: string): BallOption | null {
		return this.balls().find(entry => entry.id === toID(itemid)) || null;
	}

	/** What a location sells, as ball entries. Items we can't use yet are skipped. */
	stockAt(locationId: string): BallOption[] {
		const stock = this.location(locationId)?.pokemart || [];
		return stock
			.map(itemid => this.ball(itemid))
			.filter((entry): entry is BallOption => !!entry?.price);
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
