/**
 * Adventure - state
 *
 * The authoritative representation of a co-op playthrough.
 *
 * This state lives in the parent process and is the source of truth for
 * everything that survives a battle. Battles themselves run in child processes
 * (see `RoomBattle.stream`), so anything that has to outlive a battle lives
 * here and gets pushed into the sim as serialized text.
 *
 * Nothing in this file may import from adventure.ts: state must stay
 * serializable and testable on its own. Nothing here knows which game is
 * being played either - that comes from the campaign.
 */

import { PRNG } from '../../sim/prng';
import type { Campaign } from './campaigns';

/** Bumped whenever the on-disk shape changes; see storage.ts for migrations. */
export const STATE_VERSION = 1;

export type AdventurePhase =
	/** Gathering players; everyone picks a starter. */
	'lobby' |
	/** Standing somewhere on the map, voting on where to go. */
	'overworld' |
	/** On a route: wild searching and the trainer gauntlet are available. */
	'route' |
	/** A sub-battle is live. */
	'battle' |
	/** Healing up. */
	'pokecenter' |
	/** Finished, or abandoned. */
	'ended';

export type StatusID = '' | 'brn' | 'par' | 'slp' | 'frz' | 'psn' | 'tox';

/**
 * A single Pokemon in a player's party.
 *
 * Deliberately *not* a Showdown `PokemonSet`: this carries runtime state
 * (current HP, status, PP, EXP) that a set has no way to express. It is
 * converted to a set - and decorated with that runtime state - only when a
 * battle is about to start.
 */
export interface PartyPokemon {
	/** Stable id so a Pokemon can be referenced across evolutions and renames. */
	uid: string;
	/** Showdown species name, e.g. "Torchic". */
	species: string;
	nickname: string;
	level: number;
	exp: number;
	moves: string[];
	/** Current PP, parallel to `moves`. */
	pp: number[];
	/** Current HP. 0 means fainted. */
	hp: number;
	maxhp: number;
	status: StatusID;
	/** Turns of sleep remaining, when status is 'slp'. */
	sleepTurns: number;
	item: string;
	ability: string;
	nature: string;
	gender: string;
	shiny: boolean;
	ivs: StatsTable;
	evs: StatsTable;
	/** Who caught it, and where. Flavour, but also who gets the EXP. */
	originalTrainer: ID;
	caughtAt: string;
}

export interface AdventurePlayerState {
	id: ID;
	name: string;
	party: PartyPokemon[];
	/** Overflow beyond the party limit. The PC, effectively. */
	box: PartyPokemon[];
	bag: { [itemid: string]: number };
	money: number;
	badges: string[];
	/** Drives battler rotation, so the same two people don't fight everything. */
	battlesFought: number;
	lastBattleAt: number;
}

export interface AdventureState {
	version: number;
	roomid: RoomID;
	/** Campaign id, e.g. 'emerald'. Everything game-specific derives from this. */
	campaign: string;
	phase: AdventurePhase;
	/** Who created it; can start it and force votes. */
	host: ID;
	/** Every roll comes from here, so an adventure is reproducible. */
	seed: PRNGSeed;
	/** Location id from the campaign's locations.json. */
	location: string;
	visited: string[];
	players: { [userid: string]: AdventurePlayerState };
	/** Join order; also the base order for battler rotation. */
	playerOrder: ID[];
	/** Index into the current route's trainer list. */
	gauntletIndex: number;
	defeatedTrainers: string[];
	createdAt: number;
	updatedAt: number;
}

/* ------------------------------------------------------------------ *
 * Stat maths
 *
 * These are the gen 1-2 and gen 3+ formulas. Campaigns from gen 3 onward all
 * use the same shape, so the generation only matters once gen 1/2 campaigns
 * exist - at which point this is where that branch goes.
 * ------------------------------------------------------------------ */

export function calcHP(base: number, iv: number, ev: number, level: number, species?: string): number {
	// Shedinja is the one species that ignores the formula entirely.
	if (species && toID(species) === 'shedinja') return 1;
	return Math.floor((2 * base + iv + Math.floor(ev / 4)) * level / 100) + level + 10;
}

export function calcStat(
	base: number, iv: number, ev: number, level: number, natureMod: number
): number {
	const stat = Math.floor((2 * base + iv + Math.floor(ev / 4)) * level / 100) + 5;
	return Math.floor(stat * natureMod);
}

/** Returns the 0.9 / 1.0 / 1.1 multiplier a nature applies to a stat. */
export function natureModifier(nature: string, stat: keyof StatsTable): number {
	if (stat === 'hp') return 1;
	const natureData = Dex.natures.get(nature);
	if (natureData.plus === stat) return 1.1;
	if (natureData.minus === stat) return 0.9;
	return 1;
}

export function recalcMaxHP(pokemon: PartyPokemon, mod: string): number {
	const species = Dex.mod(mod).species.get(pokemon.species);
	return calcHP(species.baseStats.hp, pokemon.ivs.hp, pokemon.evs.hp, pokemon.level, pokemon.species);
}

/* ------------------------------------------------------------------ *
 * Building a Pokemon
 * ------------------------------------------------------------------ */

const EMPTY_EVS: StatsTable = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };

const STAT_IDS: (keyof StatsTable)[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

function randomIVs(prng: PRNG): StatsTable {
	const ivs = {} as StatsTable;
	for (const stat of STAT_IDS) ivs[stat] = prng.random(32);
	return ivs;
}

function randomGender(prng: PRNG, species: Species): string {
	if (species.gender) return species.gender;
	const ratio = species.genderRatio;
	if (!ratio || (!ratio.M && !ratio.F)) return 'N';
	return prng.random() < ratio.M ? 'M' : 'F';
}

/**
 * The moves a species would know at `level` if it levelled up naturally:
 * the last few level-up moves it is eligible for.
 *
 * Showdown already stores level-up data per generation as `"3L15"` entries, so
 * this reads the real learnset rather than a second imported copy of it.
 */
export function levelUpMoveset(speciesName: string, level: number, mod: string, maxMoves = 4): string[] {
	const dex = Dex.mod(mod);
	const gen = dex.gen;
	const learnsetData = dex.species.getLearnsetData(toID(speciesName));
	const learned: { move: string, level: number }[] = [];

	for (const moveid in learnsetData.learnset || {}) {
		let earliest = Infinity;
		for (const source of learnsetData.learnset![moveid]) {
			// Sources look like "3L15": generation, method, then the level.
			if (parseInt(source.charAt(0)) !== gen) continue;
			if (source.charAt(1) !== 'L') continue;
			const learnLevel = parseInt(source.slice(2)) || 1;
			if (learnLevel <= level && learnLevel < earliest) earliest = learnLevel;
		}
		if (earliest !== Infinity) learned.push({ move: moveid, level: earliest });
	}

	// Latest-learned wins, which is what levelling up naturally would leave you with.
	learned.sort((a, b) => a.level - b.level);
	const moves = learned.slice(-maxMoves).map(entry => entry.move);

	// Every Pokemon needs to be able to do *something*.
	if (!moves.length) moves.push(dex.moves.get('tackle').exists ? 'tackle' : 'struggle');
	return moves;
}

/** Base PP for a move, with no PP Ups applied. */
export function movePP(moveid: string, mod: string): number {
	const move = Dex.mod(mod).moves.get(moveid);
	return move.pp || 5;
}

let uidCounter = 0;
function nextUID(): string {
	return `${Date.now().toString(36)}${(uidCounter++).toString(36)}`;
}

/**
 * Creates a fresh Pokemon, rolled from the adventure's PRNG so the whole run
 * stays reproducible from its seed.
 */
export function createPokemon(options: {
	campaign: Campaign,
	species: string,
	level: number,
	prng: PRNG,
	trainer: ID,
	location: string,
	item?: string,
	moves?: string[],
}): PartyPokemon {
	const manifest = options.campaign.manifest;
	const mod = manifest.mod;
	const dex = Dex.mod(mod);
	const species = dex.species.get(options.species);
	if (!species.exists) throw new Error(`Unknown species for ${manifest.id}: ${options.species}`);

	const prng = options.prng;
	const moves = options.moves || levelUpMoveset(species.name, options.level, mod, manifest.maxMoves);
	const abilities = Object.values(species.abilities).filter(Boolean) as string[];

	const pokemon: PartyPokemon = {
		uid: nextUID(),
		species: species.name,
		nickname: '',
		level: options.level,
		exp: 0,
		moves,
		pp: moves.map(move => movePP(move, mod)),
		hp: 0,
		maxhp: 0,
		status: '',
		sleepTurns: 0,
		item: options.item || '',
		ability: abilities.length ? prng.sample(abilities) : '',
		nature: Dex.natures.get(prng.sample(Object.keys(Dex.data.Natures))).name,
		gender: randomGender(prng, species),
		shiny: prng.randomChance(1, manifest.shinyRate),
		ivs: randomIVs(prng),
		evs: { ...EMPTY_EVS },
		originalTrainer: options.trainer,
		caughtAt: options.location,
	};

	pokemon.maxhp = recalcMaxHP(pokemon, mod);
	pokemon.hp = pokemon.maxhp;
	return pokemon;
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

export function isFainted(pokemon: PartyPokemon): boolean {
	return pokemon.hp <= 0;
}

export function isPartyWiped(player: AdventurePlayerState): boolean {
	return player.party.length > 0 && player.party.every(isFainted);
}

export function isEveryoneWiped(state: AdventureState): boolean {
	const players = Object.values(state.players);
	return players.length > 0 && players.every(isPartyWiped);
}

/** Restores a party to full HP, status and PP. The Pokemon Centre, basically. */
export function healParty(player: AdventurePlayerState, mod: string): void {
	for (const pokemon of player.party) {
		pokemon.maxhp = recalcMaxHP(pokemon, mod);
		pokemon.hp = pokemon.maxhp;
		pokemon.status = '';
		pokemon.sleepTurns = 0;
		pokemon.pp = pokemon.moves.map(move => movePP(move, mod));
	}
}

export function displayName(pokemon: PartyPokemon): string {
	return pokemon.nickname || pokemon.species;
}

/* ------------------------------------------------------------------ *
 * Construction
 * ------------------------------------------------------------------ */

export function createPlayerState(user: User, campaign: Campaign): AdventurePlayerState {
	return {
		id: user.id,
		name: user.name,
		party: [],
		box: [],
		bag: {},
		money: campaign.manifest.startMoney,
		badges: [],
		battlesFought: 0,
		lastBattleAt: 0,
	};
}

export function createAdventureState(roomid: RoomID, host: User, campaign: Campaign): AdventureState {
	const now = Date.now();
	return {
		version: STATE_VERSION,
		roomid,
		campaign: campaign.id,
		phase: 'lobby',
		host: host.id,
		seed: PRNG.generateSeed(),
		location: campaign.manifest.startLocation,
		visited: [campaign.manifest.startLocation],
		players: {},
		playerOrder: [],
		gauntletIndex: 0,
		defeatedTrainers: [],
		createdAt: now,
		updatedAt: now,
	};
}
