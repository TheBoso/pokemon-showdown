/**
 * Adventure - EXP, levels, moves and evolution
 *
 * Showdown has no concept of a Pokemon getting stronger: a battle is between
 * two fixed teams and nothing carries out of it. So everything on this side of
 * a fight lives here, in the parent process, operating on run state.
 *
 * The numbers are gen 3's own. Base EXP yields and growth curves come from the
 * campaign's `species-extra.json` (Showdown's dex carries neither), evolution
 * methods from its `evolutions.json`, and level-up movesets from Showdown's
 * *own* learnsets, which already encode gen 3 level-up data as `"3L15"` - so
 * there is no second copy of that to keep in sync.
 *
 * Nothing here mutates anything the player has to decide about. Learning a
 * move over a full moveset, and evolving, are choices, so they come back as
 * `Pending` prompts for the owner to answer.
 */

import type { Campaign } from './campaigns';
import {
	expForLevel, movePP, recalcMaxHP, MAX_LEVEL,
	type AdventurePlayerState, type PartyPokemon, type Pending,
} from './state';

/**
 * How far this Pokemon is through its current level, as 0-1.
 *
 * Purely for the progress bar. A Pokemon at the cap reads as full rather than
 * dividing by a zero-width band.
 */
export function levelProgress(campaign: Campaign, pokemon: PartyPokemon): number {
	if (pokemon.level >= MAX_LEVEL) return 1;
	const start = expForLevel(campaign, pokemon.species, pokemon.level);
	const next = expForLevel(campaign, pokemon.species, pokemon.level + 1);
	if (next <= start) return 1;
	return Math.max(0, Math.min(1, (pokemon.exp - start) / (next - start)));
}

/** EXP still owed before the next level. */
export function expToNextLevel(campaign: Campaign, pokemon: PartyPokemon): number {
	if (pokemon.level >= MAX_LEVEL) return 0;
	return Math.max(0, expForLevel(campaign, pokemon.species, pokemon.level + 1) - pokemon.exp);
}

/* ------------------------------------------------------------------ *
 * Earning it
 * ------------------------------------------------------------------ */

/** A Pokemon that fainted, and is therefore worth something. */
export interface ExpSource {
	species: string;
	level: number;
	/** Trainer battles pay more than wild ones, as they do in the games. */
	fromTrainer: boolean;
}

/** Gen 3 pays 1.5x for a trainer's Pokemon over a wild one. */
const TRAINER_BONUS = 1.5;

/** Base EXP for anything the campaign has no yield for. */
const DEFAULT_BASE_EXP = 64;

/**
 * The gen 3 formula: `base * level / 7`, split between everyone who fought it.
 *
 * Gen 3 splits by *participants* - whoever was sent out against that Pokemon -
 * not by party size, which is why the caller tracks who was on the field
 * rather than just handing over the whole party.
 */
export function expYield(campaign: Campaign, source: ExpSource, participants: number): number {
	const baseExp = campaign.extraFor(source.species)?.baseExp ?? DEFAULT_BASE_EXP;
	const share = Math.max(1, participants);
	const bonus = source.fromTrainer ? TRAINER_BONUS : 1;
	return Math.max(1, Math.floor(baseExp * source.level * bonus / (7 * share)));
}

/* ------------------------------------------------------------------ *
 * Levelling up
 * ------------------------------------------------------------------ */

/** What happened to one Pokemon when EXP landed on it. */
export interface LevelResult {
	pokemon: PartyPokemon;
	gained: number;
	levelsGained: number;
	/** Moves learned outright, because there was a free slot. */
	learned: string[];
	/** Decisions the owner has to make: a full moveset, or an evolution. */
	pending: Pending[];
}

/**
 * Moves this species learns at exactly this level.
 *
 * Read from Showdown's learnsets, which encode gen 3 level-up data as `3L15`.
 * `levelUpMoveset` reads the same table for building a fresh Pokemon; this is
 * the single-level view of it.
 */
export function movesLearnedAt(speciesName: string, level: number, mod: string): string[] {
	const dex = Dex.mod(mod);
	const learnsetData = dex.species.getLearnsetData(toID(speciesName));
	const moves: string[] = [];

	for (const moveid in learnsetData.learnset || {}) {
		for (const source of learnsetData.learnset![moveid]) {
			// "3L15": generation, method, level.
			if (parseInt(source.charAt(0)) !== dex.gen) continue;
			if (source.charAt(1) !== 'L') continue;
			if ((parseInt(source.slice(2)) || 1) !== level) continue;
			moves.push(moveid);
			break;
		}
	}
	return moves;
}

/**
 * Applies a Pokemon's current EXP total, levelling it as far as that total
 * takes it and collecting everything that happened on the way.
 *
 * HP is carried up rather than refilled: a level-up in Emerald raises current
 * HP by exactly the maximum's increase, so a Pokemon that levelled at 3 HP is
 * still in trouble. Fainted party members level too - they earn nothing, but
 * they can be pushed over a threshold by a later fix to their EXP - so this
 * checks `hp > 0` before topping anything up.
 */
export function applyExp(
	campaign: Campaign, pokemon: PartyPokemon, gained: number
): LevelResult {
	const mod = campaign.mod;
	const result: LevelResult = { pokemon, gained, levelsGained: 0, learned: [], pending: [] };

	if (gained > 0) pokemon.exp += gained;
	if (pokemon.level >= MAX_LEVEL) return result;

	while (
		pokemon.level < MAX_LEVEL &&
		pokemon.exp >= expForLevel(campaign, pokemon.species, pokemon.level + 1)
	) {
		pokemon.level++;
		result.levelsGained++;

		const before = pokemon.maxhp;
		pokemon.maxhp = recalcMaxHP(pokemon, mod);
		// A fainted Pokemon stays fainted; it does not wake up one HP richer.
		if (pokemon.hp > 0) pokemon.hp = Math.min(pokemon.maxhp, pokemon.hp + (pokemon.maxhp - before));

		for (const moveid of movesLearnedAt(pokemon.species, pokemon.level, mod)) {
			if (pokemon.moves.includes(moveid)) continue;

			if (pokemon.moves.length < campaign.manifest.maxMoves) {
				pokemon.moves.push(moveid);
				pokemon.pp.push(movePP(moveid, mod));
				result.learned.push(moveid);
			} else {
				// A full moveset makes this a real decision, so it goes to the
				// owner rather than being resolved by picking a slot for them.
				result.pending.push({ kind: 'learn', uid: pokemon.uid, move: moveid, level: pokemon.level });
			}
		}

		// Asked once, not once per level: something that gains four levels past
		// its evolution threshold in one battle should get one prompt, not four.
		const evolution = evolutionAt(campaign, pokemon);
		if (evolution && !result.pending.some(entry => entry.kind === 'evolve')) {
			result.pending.push({ kind: 'evolve', uid: pokemon.uid, into: evolution, level: pokemon.level });
		}
	}

	// The cap is a cap: overshooting it should not leave a bar reading past full.
	if (pokemon.level >= MAX_LEVEL) {
		pokemon.exp = expForLevel(campaign, pokemon.species, MAX_LEVEL);
	}
	return result;
}

/* ------------------------------------------------------------------ *
 * Evolution
 * ------------------------------------------------------------------ */

/**
 * Which species this Pokemon should be offered right now, if any.
 *
 * Only the level-triggered kinds can fire here. Stones need a shop that sells
 * them, trading needs trading, and friendship and beauty need stats nobody
 * tracks - all of those are in the data, waiting for the system that gates
 * them, and are silently skipped until then.
 */
export function evolutionAt(campaign: Campaign, pokemon: PartyPokemon): string | null {
	const dex = Dex.mod(campaign.mod);

	for (const entry of campaign.evolutionsFor(pokemon.species)) {
		if (entry.level === undefined || pokemon.level < entry.level) continue;
		if (!dex.species.get(entry.into).exists) continue;

		switch (entry.kind) {
		case 'level':
		case 'levelNinjask':
			return entry.into;

			// Wurmple splits on a personality value the ROM rolls at generation.
			// Nothing here carries one, so the Pokemon's own uid stands in: it is
			// fixed at creation and unique, so a given Wurmple always has been
			// going to become the same thing.
			// Both halves of the split are separate entries in the same list, so
			// these break rather than returning null on a miss - bailing out on
			// the first would leave every Cascoon-flavoured Wurmple unable to
			// evolve into anything at all.
		case 'levelSilcoon':
			if (personalitySplit(pokemon)) return entry.into;
			break;
		case 'levelCascoon':
			if (!personalitySplit(pokemon)) return entry.into;
			break;

			// Tyrogue, which splits on the stats it grew into.
		case 'levelAtkGtDef':
			if (compareAtkDef(campaign, pokemon) > 0) return entry.into;
			break;
		case 'levelAtkLtDef':
			if (compareAtkDef(campaign, pokemon) < 0) return entry.into;
			break;
		case 'levelAtkEqDef':
			if (compareAtkDef(campaign, pokemon) === 0) return entry.into;
			break;

			// `levelShedinja` is not an evolution of the Pokemon holding it - it
			// is an extra one left behind, handled at the moment Ninjask is
			// applied, where the party and the bag are both in reach.
		default:
			break;
		}
	}
	return null;
}

/** Emerald's Wurmple coin flip, made stable per individual. */
function personalitySplit(pokemon: PartyPokemon): boolean {
	let hash = 0;
	for (let i = 0; i < pokemon.uid.length; i++) {
		hash = (hash * 31 + pokemon.uid.charCodeAt(i)) % 1000003;
	}
	return hash % 10 < 5;
}

/** Tyrogue's branch, on the Attack and Defense it actually has. */
function compareAtkDef(campaign: Campaign, pokemon: PartyPokemon): number {
	const species = Dex.mod(campaign.mod).species.get(pokemon.species);
	const atk = species.baseStats.atk * 2 + pokemon.ivs.atk;
	const def = species.baseStats.def * 2 + pokemon.ivs.def;
	return atk - def;
}

/**
 * Turns a Pokemon into what it evolves into.
 *
 * HP carries over by the increase, as levelling does, so evolving mid-route is
 * a boost rather than a heal. The ability is remapped by slot: a Pokemon with
 * its species' second ability keeps the second one, which is how the games
 * handle it and what keeps a Torchic's Blaze from becoming a Combusken's
 * something else.
 */
export function evolve(campaign: Campaign, pokemon: PartyPokemon, into: string): boolean {
	const dex = Dex.mod(campaign.mod);
	const before = dex.species.get(pokemon.species);
	const after = dex.species.get(into);
	if (!after.exists) return false;

	const oldAbilities = Object.values(before.abilities).filter(Boolean) as string[];
	const newAbilities = Object.values(after.abilities).filter(Boolean) as string[];
	const slot = Math.max(0, oldAbilities.indexOf(pokemon.ability));

	pokemon.species = after.name;
	pokemon.ability = newAbilities[slot] || newAbilities[0] || pokemon.ability;

	const beforeMax = pokemon.maxhp;
	pokemon.maxhp = recalcMaxHP(pokemon, campaign.mod);
	if (pokemon.hp > 0) {
		pokemon.hp = Math.min(pokemon.maxhp, pokemon.hp + (pokemon.maxhp - beforeMax));
	} else {
		// Shedinja is the exception the HP formula already knows about: one HP,
		// always. A fainted one must not come back with that one HP filled.
		pokemon.hp = 0;
	}
	return true;
}

/**
 * Nincada's second evolution: a Shedinja left behind in a spare party slot.
 *
 * Emerald requires both an empty slot *and* a spare Poke Ball, and consumes
 * the ball. Miss either and Ninjask is all you get, with no message - which is
 * how a generation of players never found out this existed.
 */
export function maybeShedinja(
	campaign: Campaign, player: AdventurePlayerState, pokemon: PartyPokemon,
	makeShedinja: (species: string, level: number) => PartyPokemon
): PartyPokemon | null {
	const extra = campaign.evolutionsFor('Nincada').find(entry => entry.kind === 'levelShedinja');
	if (!extra || pokemon.species !== 'Ninjask') return null;
	if (player.party.length >= campaign.manifest.maxPartySize) return null;

	const ball = campaign.balls().find(entry => (player.bag[entry.id] || 0) > 0);
	if (!ball) return null;

	player.bag[ball.id]--;
	const shedinja = makeShedinja(extra.into, pokemon.level);
	player.party.push(shedinja);
	return shedinja;
}

/**
 * Swaps a new move in over an existing one, at full PP.
 *
 * False means the swap was refused - the slot is out of range, or the move is
 * already known - which is what a stale button from a panel that was open when
 * the answer already went in looks like.
 */
export function forgetMove(
	campaign: Campaign, pokemon: PartyPokemon, move: string, slot: number
): boolean {
	if (slot < 0 || slot >= pokemon.moves.length) return false;
	if (pokemon.moves.includes(move)) return false;

	pokemon.moves[slot] = move;
	pokemon.pp[slot] = movePP(move, campaign.mod);
	return true;
}
