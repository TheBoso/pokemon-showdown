/**
 * Adventure - turning adventure state into Showdown teams
 *
 * Two directions meet here: a player's party (which carries runtime state a
 * `PokemonSet` cannot express) and a trainer's roster (which is already close
 * to a set). Both come out as sets ready to hand to the simulator.
 *
 * Sets are passed to the sim as *objects*, not packed strings. `Battle#getTeam`
 * accepts either, and objects survive the trip into the battle child process as
 * JSON with any extra fields intact - which is what M4's HP persistence will
 * ride on. The `runState` attached here is inert until then, but it costs
 * nothing to carry and means the plumbing is already correct when the ruleset
 * that reads it arrives.
 */

import type { TrainerData } from './campaigns';
import { displayName, movePP, type AdventurePlayerState, type PartyPokemon } from './state';

/** A Showdown set plus the runtime state the simulator does not model. */
export interface AdventureSet extends AnyObject {
	name: string;
	species: string;
	item: string;
	ability: string;
	moves: string[];
	nature: string;
	gender: string;
	evs: StatsTable;
	ivs: StatsTable;
	level: number;
	shiny: boolean;
	/** Current HP, status and PP. Read by the campaign ruleset from M4 onward. */
	runState?: {
		uid: string,
		hp: number,
		maxhp: number,
		status: string,
		sleepTurns: number,
		pp: number[],
	};
}

/**
 * One party Pokemon as a set.
 *
 * Moves are filtered to ones that actually exist in the mod: a party member
 * that somehow acquired a bad move should lose the move, not crash the battle.
 */
export function partyPokemonToSet(pokemon: PartyPokemon, mod: string): AdventureSet {
	const dex = Dex.mod(mod);
	const moves = pokemon.moves
		.map(move => dex.moves.get(move))
		.filter(move => move.exists)
		.map(move => move.name);

	return {
		name: displayName(pokemon),
		species: pokemon.species,
		item: pokemon.item,
		ability: pokemon.ability,
		moves: moves.length ? moves : ['Struggle'],
		nature: pokemon.nature,
		gender: pokemon.gender,
		evs: { ...pokemon.evs },
		ivs: { ...pokemon.ivs },
		level: pokemon.level,
		shiny: pokemon.shiny,
		runState: {
			uid: pokemon.uid,
			hp: pokemon.hp,
			maxhp: pokemon.maxhp,
			status: pokemon.status,
			sleepTurns: pokemon.sleepTurns,
			pp: [...pokemon.pp],
		},
	};
}

/**
 * A player's battle team: their party, minus anyone who has fainted.
 *
 * Showdown has no way to start a battle with a fainted Pokemon on the team, so
 * they are left behind rather than sent out dead. A party wiped entirely is the
 * caller's problem to catch before getting here.
 */
export function partyToTeam(player: AdventurePlayerState, mod: string): AdventureSet[] {
	return player.party
		.filter(pokemon => pokemon.hp > 0)
		.map(pokemon => partyPokemonToSet(pokemon, mod));
}

/** One trainer roster entry as a set. */
export function trainerToTeam(trainer: TrainerData, mod: string): AdventureSet[] {
	const dex = Dex.mod(mod);
	return trainer.team.map(mon => {
		const moves = mon.moves
			.map(move => dex.moves.get(move))
			.filter(move => move.exists)
			.map(move => move.name);

		return {
			name: mon.species,
			species: mon.species,
			item: mon.item || '',
			ability: mon.ability || '',
			moves: moves.length ? moves : ['Struggle'],
			nature: mon.nature || 'Serious',
			gender: '',
			evs: { ...mon.evs },
			ivs: { ...mon.ivs },
			level: mon.level,
			shiny: false,
			runState: {
				uid: '',
				hp: 0,
				maxhp: 0,
				status: '',
				sleepTurns: 0,
				pp: moves.map(move => movePP(move, mod)),
			},
		};
	});
}

/**
 * Splits a trainer's roster across the two slots a multi battle gives their
 * side, alternating so the lead is preserved.
 *
 * Most Emerald trainers are one person; a multi battle needs two opposing
 * slots. Dealing the party out alternately keeps their strongest lead in front
 * rather than stacking the good Pokemon on one slot.
 */
export function splitTrainerTeam(team: AdventureSet[]): [AdventureSet[], AdventureSet[]] {
	const first: AdventureSet[] = [];
	const second: AdventureSet[] = [];
	team.forEach((set, index) => (index % 2 === 0 ? first : second).push(set));
	return [first, second];
}
