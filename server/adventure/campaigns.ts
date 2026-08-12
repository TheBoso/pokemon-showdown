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

export interface LocationData {
	name: string;
	kind: 'town' | 'route' | 'cave' | 'gym' | 'building';
	connections: string[];
	/** Key into encounters.json, when the location has wild Pokemon. */
	encounters?: string;
	/** Trainer ids, in gauntlet order. */
	trainers?: string[];
	pokecenter?: boolean;
	pokemart?: string[];
	/** Badge or key item gating access. */
	requires?: string | null;
}

export interface TrainerData {
	name: string;
	trainerClass: string;
	/** Packed or unpacked Showdown sets. */
	team: AnyObject[];
	prize?: number;
	/** Emerald's AI script flags, for faithful behaviour later. */
	ai?: string[];
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

	locations(): { [id: string]: LocationData } | null {
		return this.load('locations');
	}

	location(id: string): LocationData | null {
		return this.locations()?.[id] || null;
	}

	trainers(): { [id: string]: TrainerData } | null {
		return this.load('trainers');
	}

	trainer(id: string): TrainerData | null {
		return this.trainers()?.[id] || null;
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
