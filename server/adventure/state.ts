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
import { emptyProgress, type Progress } from './progress';

/** Bumped whenever the on-disk shape changes; see storage.ts for migrations. */
export const STATE_VERSION = 6;

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

/**
 * A decision waiting on one player.
 *
 * Levelling up can raise questions only the owner can answer - which move to
 * give up for a new one, whether to let something evolve - and a co-op run
 * cannot stop for them: five other people are mid-adventure. So they queue
 * here, render in that player's panel, and wait. Ignoring one forever is a
 * legal answer, and means "no".
 */
export type Pending =
	{ kind: 'learn', uid: string, move: string, level: number } |
	{ kind: 'evolve', uid: string, into: string, level: number };

export interface AdventurePlayerState {
	/**
	 * Stable identity for this player, independent of their userid.
	 *
	 * Userids are not stable: a guest who picks a name becomes a different
	 * user, and keying a party to a userid would orphan it mid-run. The token
	 * is assigned once at join and never changes, so renaming is free.
	 */
	token: string;
	/** Current userid. Updated on rename; may be a guest id. */
	userid: ID;
	name: string;
	party: PartyPokemon[];
	/** Overflow beyond the party limit. The PC, effectively. */
	box: PartyPokemon[];
	bag: { [itemid: string]: number };
	money: number;
	/** Move-learning and evolution choices this player has not answered yet. */
	pending: Pending[];
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
	/** Token of whoever created it; can start it and force votes. */
	host: string;
	/** Every roll comes from here, so an adventure is reproducible. */
	seed: PRNGSeed;
	/** Location id from the campaign's locations.json. */
	location: string;
	/**
	 * Where the party walked in from.
	 *
	 * A route's trainers must be cleared before moving on, but retreating the
	 * way you came is always allowed - so this is the one exit that stays open
	 * while a gauntlet is unfinished.
	 */
	cameFrom: string;
	/**
	 * Where the party wakes up after a total wipe.
	 *
	 * Updated on arrival at anywhere with a Pokemon Centre. Emerald sends you
	 * back to the last one you visited, not to the start.
	 */
	lastPokecenter: string;
	visited: string[];
	/**
	 * Badges, HMs, key items and story flags, held by the group rather than by
	 * individuals - everyone travels together, so a gate cannot open for one
	 * player and not another.
	 */
	progress: Progress;
	/** Keyed by token, not userid - see `AdventurePlayerState.token`. */
	players: { [token: string]: AdventurePlayerState };
	/** userid -> token, so a returning or renamed user reclaims their party. */
	playerTokens: { [userid: string]: string };
	/** Join order, as tokens; also the base order for battler rotation. */
	playerOrder: string[];
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
 * Growth curves
 *
 * The six gen 3 curves, as the total EXP needed to *be* a given level. Two of
 * them are piecewise, which is why this is a table of functions rather than
 * one formula with a coefficient.
 *
 * These live here beside the stat maths, rather than in progression.ts with
 * everything else about levelling, for one reason: `createPokemon` needs them.
 * A Pokemon made at level 20 must start with the EXP of a level 20, or the
 * next level would cost it a whole curve's worth instead of one band. Keeping
 * the curves here is what lets progression.ts depend on state.ts and not the
 * other way about.
 * ------------------------------------------------------------------ */

export const MAX_LEVEL = 100;

type Curve = (level: number) => number;

const CURVES: { [name: string]: Curve } = {
	fast: n => Math.floor(4 * n ** 3 / 5),
	mediumfast: n => n ** 3,
	// Dips below zero for the first couple of levels; the games clamp, so do we.
	mediumslow: n => Math.max(0, Math.floor(6 * n ** 3 / 5 - 15 * n ** 2 + 100 * n - 140)),
	slow: n => Math.floor(5 * n ** 3 / 4),
	erratic: n => {
		if (n < 50) return Math.floor(n ** 3 * (100 - n) / 50);
		if (n < 68) return Math.floor(n ** 3 * (150 - n) / 100);
		if (n < 98) return Math.floor(n ** 3 * Math.floor((1911 - 10 * n) / 3) / 500);
		return Math.floor(n ** 3 * (160 - n) / 100);
	},
	fluctuating: n => {
		if (n < 15) return Math.floor(n ** 3 * (Math.floor((n + 1) / 3) + 24) / 50);
		if (n < 36) return Math.floor(n ** 3 * (n + 14) / 50);
		return Math.floor(n ** 3 * (Math.floor(n / 2) + 32) / 50);
	},
};

/** Medium Fast is the curve half the dex uses, and a safe answer for the rest. */
const DEFAULT_CURVE = 'mediumfast';

/** Total EXP needed to be this level. */
export function expForLevel(campaign: Campaign, species: string, level: number): number {
	const name = campaign.extraFor(species)?.growthRate || DEFAULT_CURVE;
	const curve = CURVES[name] || CURVES[DEFAULT_CURVE];
	return curve(Math.max(1, Math.min(level, MAX_LEVEL)));
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
		// The EXP of something that *is* this level, not of something starting
		// from nothing - otherwise a Lv20 catch would owe a whole curve before
		// reaching 21 instead of one band's worth.
		exp: expForLevel(options.campaign, species.name, options.level),
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

/** Opaque, stable, and not derived from the userid - that is the whole point. */
export function generateToken(): string {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function createPlayerState(user: User, campaign: Campaign): AdventurePlayerState {
	return {
		token: generateToken(),
		userid: user.id,
		name: user.name,
		party: [],
		box: [],
		bag: { ...campaign.manifest.startBag },
		money: campaign.manifest.startMoney,
		pending: [],
		battlesFought: 0,
		lastBattleAt: 0,
	};
}

export function createAdventureState(roomid: RoomID, campaign: Campaign): AdventureState {
	const now = Date.now();
	return {
		version: STATE_VERSION,
		roomid,
		campaign: campaign.id,
		phase: 'lobby',
		// Set once the host joins and has a token.
		host: '',
		seed: PRNG.generateSeed(),
		location: campaign.manifest.startLocation,
		cameFrom: '',
		lastPokecenter: campaign.manifest.startLocation,
		visited: [campaign.manifest.startLocation],
		progress: emptyProgress(),
		players: {},
		playerTokens: {},
		playerOrder: [],
		gauntletIndex: 0,
		defeatedTrainers: [],
		createdAt: now,
		updatedAt: now,
	};
}
