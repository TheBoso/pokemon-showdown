/**
 * Poke Balls, as moves.
 *
 * Throwing a ball is a turn: it has priority, the wild Pokemon still acts if
 * the throw fails, and the whole thing sits inside the simulator's own turn
 * order rather than being bolted on beside it. Modelling the ball as a chat
 * command would have meant resolving a catch against HP that the sim was
 * simultaneously changing.
 *
 * The catch itself uses the gen 3 formula. `catchRate` comes from the campaign
 * data (Showdown's dex has no such field) and is passed in on the move's
 * `catchRateOverride`, set per battle by the caller.
 */

/** Gen 3 status multipliers for the catch roll. */
const STATUS_BONUS: { [status: string]: number } = {
	slp: 2, frz: 2, par: 1.5, psn: 1.5, tox: 1.5, brn: 1.5,
};

/**
 * Gen 3 catch odds.
 *
 * a = (3*max - 2*cur) * rate * ball / (3*max) * status
 * Then four shake checks against b = 1048560 / sqrt(sqrt(16711680 / a)).
 * Returns the number of shakes (0-4); 4 means caught.
 */
function catchShakes(
	battle: Battle, target: Pokemon, catchRate: number, ballBonus: number
): number {
	const max = target.maxhp;
	const cur = target.hp;
	const status = STATUS_BONUS[target.status] || 1;

	let a = ((3 * max - 2 * cur) * catchRate * ballBonus) / (3 * max);
	a = Math.floor(a * status);
	if (a >= 255) return 4;
	if (a < 1) a = 1;

	const b = Math.floor(1048560 / Math.floor(Math.sqrt(Math.floor(Math.sqrt(Math.floor(16711680 / a))))));
	let shakes = 0;
	while (shakes < 4) {
		if (battle.random(65536) >= b) break;
		shakes++;
	}
	return shakes;
}

function ball(name: string, bonus: number, num: number): any {
	return {
		num: -num,
		accuracy: true,
		basePower: 0,
		category: "Status",
		name,
		pp: 1,
		// Balls go first, as they do in the games.
		priority: 6,
		flags: { bypasssub: 1 },
		target: "normal",
		type: "Normal",
		desc: `Attempts to catch the target. Only works on wild Pokémon.`,
		shortDesc: `Attempts to catch a wild Pokémon.`,
		onPrepareHit(this: Battle, target: Pokemon, source: Pokemon) {
			this.add('-anim', source, name, target);
		},
		onTryHit(this: Battle, target: Pokemon, source: Pokemon) {
			// Only ever legal against a wild Pokemon. The caller marks the wild
			// side; against a trainer this fails harmlessly and wastes the turn,
			// exactly as throwing a ball at someone else's Pokemon does.
			if (!(this as any).adventureWildSide || target.side.id !== (this as any).adventureWildSide) {
				this.add('-message', `The trainer blocked the Ball! Don't be a thief!`);
				return null;
			}
			return undefined;
		},
		onHit(this: Battle, target: Pokemon, source: Pokemon) {
			const rate = (this as any).adventureCatchRate || 45;
			const shakes = catchShakes(this, target, rate, bonus);

			// Reported as a message rather than a custom protocol line so the
			// unmodified client renders it without knowing this mod exists.
			for (let i = 0; i < Math.min(shakes, 3); i++) {
				this.add('-message', `...`);
			}

			if (shakes < 4) {
				const complaint = [
					`Oh no! The Pokémon broke free!`,
					`Aww! It appeared to be caught!`,
					`Aargh! Almost had it!`,
					`Shoot! It was so close, too!`,
				][shakes];
				this.add('-message', complaint);
				return;
			}

			this.add('-message', `Gotcha! ${target.species.name} was caught!`);
			// A caught Pokemon leaves the battle, which ends it - the wild side
			// has nothing else to send out.
			(this as any).adventureCaught = {
				species: target.species.name,
				level: target.level,
			};
			target.faint();
		},
	};
}

/**
 * Names deliberately carry no accent. `toID` strips anything outside a-z0-9
 * without normalising first, so "Poké Ball" becomes `pokball` and would not
 * match a `pokeball` key - the move would silently resolve to nothing, which
 * shows up only as NaN PP and a `|cant|nopp|` at the moment of use.
 */
export const Moves: import('../../../sim/dex-moves').ModdedMoveDataTable = {
	pokeball: ball("Poke Ball", 1, 1),
	greatball: ball("Great Ball", 1.5, 2),
	ultraball: ball("Ultra Ball", 2, 3),
	// A Master Ball never fails: a >= 255 short-circuits to four shakes.
	masterball: ball("Master Ball", 255, 4),
};
