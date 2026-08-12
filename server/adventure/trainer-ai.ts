/**
 * Adventure - trainer AI
 *
 * Picks moves and switches for a battle slot with no human behind it.
 *
 * Deliberately a heuristic rather than a search. Emerald's trainers are not
 * good players, and an AI that plays perfectly would make a co-op playthrough
 * miserable long before the badges got hard. The aim is "competent enough to
 * punish a bad matchup", not "wins".
 *
 * The AI sees only what a `|request|` gives it - its own side - plus whatever
 * the caller has managed to observe about the foe's active Pokemon from the
 * battle log. Everything degrades: with no knowledge of the foe it falls back
 * to raw power, which is roughly what a Youngster does anyway.
 */

export interface FoeView {
	species: string;
	/** Fraction of max HP remaining, 0-1, if known. */
	hpFraction?: number;
}

export interface AIContext {
	mod: string;
	/** What the AI can see across the field. Empty when nothing is known yet. */
	foeActive: FoeView[];
	/** Emerald AI script flags for this trainer, e.g. CHECK_BAD_MOVE. */
	flags?: string[];
	/** Tie-break, so a battle replays identically from the same seed. */
	pick: <T>(items: T[]) => T;
}

/** The subset of a Showdown request this AI cares about. */
interface RequestMove {
	move: string;
	id: string;
	pp?: number;
	maxpp?: number;
	target?: string;
	disabled?: boolean;
}

interface RequestActive {
	moves: RequestMove[];
	trapped?: boolean;
	maybeTrapped?: boolean;
}

interface RequestSidePokemon {
	ident: string;
	details: string;
	condition: string;
	active: boolean;
}

export interface AIRequest {
	active?: RequestActive[];
	forceSwitch?: boolean[];
	teamPreview?: boolean;
	wait?: boolean;
	side?: { pokemon: RequestSidePokemon[] };
	rqid?: number;
}

/** `"39/39"`, `"0 fnt"`, `"12/39 par"` -> is it still standing? */
function isAlive(condition: string): boolean {
	return !!condition && !condition.startsWith('0 ') && !condition.endsWith(' fnt');
}

/** A status move is worth *something*, but never more than a real attack. */
const STATUS_MOVE_SCORE = 12;

/**
 * How much a move is worth against the current foe.
 *
 * Base power, doubled for STAB, scaled by type effectiveness. Immunities score
 * zero so the AI stops throwing Normal moves at Ghosts - which is most of what
 * CHECK_BAD_MOVE does in the real game.
 */
function scoreMove(move: RequestMove, attacker: string | null, foe: FoeView | undefined, mod: string): number {
	const dex = Dex.mod(mod);
	const moveData = dex.moves.get(move.id);
	if (!moveData.exists) return 0;

	if (moveData.category === 'Status') return STATUS_MOVE_SCORE;

	let score = moveData.basePower || 0;
	// Fixed-damage and variable-power moves report 0 base power; they are still
	// real attacks, so give them a middling score rather than discarding them.
	if (!score) score = 40;

	if (attacker) {
		const attackerSpecies = dex.species.get(attacker);
		if (attackerSpecies.exists && attackerSpecies.types.includes(moveData.type)) score *= 1.5;
	}

	if (foe) {
		const foeSpecies = dex.species.get(foe.species);
		if (foeSpecies.exists) {
			const effectiveness = dex.getEffectiveness(moveData.type, foeSpecies.types);
			const immune = !dex.getImmunity(moveData.type, foeSpecies.types);
			if (immune) return 0;
			score *= 2 ** effectiveness;
		}
	}

	// Accuracy matters enough that a 70% move should lose to a comparable 100%.
	const accuracy = typeof moveData.accuracy === 'number' ? moveData.accuracy / 100 : 1;
	return score * accuracy;
}

/** The species of our own active Pokemon, for STAB. */
function activeSpecies(request: AIRequest): string | null {
	const active = request.side?.pokemon.find(pokemon => pokemon.active);
	if (!active) return null;
	// details looks like "Geodude, L12, M"
	return active.details.split(',')[0].trim() || null;
}

/** Indices of party members that could be switched to. */
function switchableIndexes(request: AIRequest): number[] {
	const party = request.side?.pokemon || [];
	const out: number[] = [];
	party.forEach((pokemon, index) => {
		if (pokemon.active) return;
		if (!isAlive(pokemon.condition)) return;
		out.push(index + 1); // Showdown switch targets are 1-indexed
	});
	return out;
}

/**
 * Decides what this slot does about one request.
 *
 * Returns a choice string for the sim (`move 2`, `switch 3`), or `default`,
 * which tells the sim to make a legal choice for us. `default` is the safety
 * net: it is always accepted, so a gap in this AI stalls nothing.
 */
export function chooseAction(request: AIRequest, context: AIContext): string {
	if (request.wait) return '';

	// Team preview: our formats do not use it, but answer legally if it appears.
	if (request.teamPreview) return 'default';

	if (request.forceSwitch?.length) {
		return request.forceSwitch
			.map(mustSwitch => {
				if (!mustSwitch) return 'pass';
				const options = switchableIndexes(request);
				if (!options.length) return 'pass';
				return `switch ${options[0]}`;
			})
			.join(', ');
	}

	if (!request.active?.length) return 'default';

	const attacker = activeSpecies(request);

	const choices = request.active.map((active, slot) => {
		const usable = (active.moves || [])
			.map((move, index) => ({ move, index: index + 1 }))
			.filter(entry => !entry.move.disabled && (entry.move.pp === undefined || entry.move.pp > 0));

		// Out of PP or everything disabled: Struggle is handled by `default`.
		if (!usable.length) return 'default';

		const foe = context.foeActive[slot] || context.foeActive[0];
		const scored = usable.map(entry => ({
			...entry,
			score: scoreMove(entry.move, attacker, foe, context.mod),
		}));

		const best = Math.max(...scored.map(entry => entry.score));
		// Everything scores zero (all immune): let the sim pick, rather than
		// deliberately using a move that cannot do anything.
		if (best <= 0) return 'default';

		const leaders = scored.filter(entry => entry.score === best);
		const chosen = leaders.length === 1 ? leaders[0] : context.pick(leaders);
		return `move ${chosen.index}`;
	});

	return choices.join(', ');
}
