/**
 * Adventure - wild encounters
 *
 * One player against one wild Pokemon, in a private sub-room. Unlike a trainer
 * battle this is *personal*: everyone searches on their own button, several of
 * these can be live at once, and none of them blocks the group's vote.
 *
 * Mechanically it is a trainer battle with a one-Pokemon opponent, so it reuses
 * `TrainerBattle` wholesale - the AI slot, the log scraping, the state
 * round-trip. What it adds is the catching: the wild side is marked catchable
 * and the player's team carries Poke Balls as extra moves, both declared on the
 * team because the team is the only thing that crosses into the battle process.
 *
 * The wild Pokemon is generated *before* the battle and kept here, so catching
 * it adds the exact individual that was fought - its nature, its IVs, its
 * shininess - rather than rerolling a fresh one with the same name.
 */

import { Utils } from '../../lib';
import { PRNG } from '../../sim/prng';
import type { RoomBattleOptions } from '../room-battle';
import { TrainerBattle } from './trainer-battle';
import { partyToWildTeam, wildToTeam } from './teams';
import { createPokemon, type AdventurePlayerState, type PartyPokemon } from './state';
import type { Campaign } from './campaigns';
import type { Encounter } from './encounters';

/** Wild Pokemon in these games are alone and never switch. */
const WILD_SLOT: SideID = 'p2';

/** Fallback when a campaign has no catch rate for a species. */
const DEFAULT_CATCH_RATE = 45;

export class WildBattle extends TrainerBattle {
	/** Whose encounter this is. Personal, so exactly one player. */
	playerToken = '';
	/**
	 * The individual on the other side.
	 *
	 * Kept whole rather than as a species name: this is what joins the party if
	 * it is caught, and half of what makes a catch feel earned is that it is
	 * *that* Pokemon, with the stats you just fought.
	 */
	wild!: PartyPokemon;
}

export function createWildBattle(options: {
	parent: Room,
	campaign: Campaign,
	player: AdventurePlayerState,
	user: User,
	encounter: Encounter,
	/** The adventure's PRNG. Advanced here; the caller must save the new seed. */
	prng: PRNG,
	location: string,
}): WildBattle | null {
	const { campaign, parent, player, encounter } = options;
	const mod = campaign.mod;

	const format = campaign.manifest.wildBattleFormat;
	if (!format) {
		Monitor.error(`Campaign ${campaign.id} has no wildBattleFormat; wild battles are off.`);
		return null;
	}

	const team = partyToWildTeam(player, mod, campaign.balls());
	// Caller's job to check, but a battle with an empty side would hang.
	if (!team.length) return null;

	let wild: PartyPokemon;
	try {
		wild = createPokemon({
			campaign,
			species: encounter.species,
			level: encounter.level,
			prng: options.prng,
			// Nobody owns it yet. Set at the moment of capture.
			trainer: '' as ID,
			location: options.location,
		});
	} catch (err: any) {
		Monitor.error(`Adventure: cannot build wild ${encounter.species} - ${err.message}`);
		return null;
	}

	const catchRate = campaign.extraFor(wild.species)?.catchRate ?? DEFAULT_CATCH_RATE;
	const title = `Wild ${wild.species}`;
	const roomid = Rooms.global.prepBattleRoom(format);

	const battleOptions: RoomBattleOptions = {
		format,
		// Positional: index 0 is p1. The wild slot is left as a hole, which is
		// what makes it userless and therefore ours to play.
		players: [{ user: options.user, team }],
		rated: false,
		allowRenames: false,
		// `RoomBattle#start` throws on a player with no User, and the wild slot
		// has none. Marked started by hand below.
		delayedStart: true,
	};

	let room: GameRoom;
	try {
		room = Rooms.createGameRoom(roomid, title, { isPrivate: 'hidden' });
	} catch (err: any) {
		Monitor.crashlog(err, 'Adventure wild battle room', { roomid });
		return null;
	}

	const battle = new WildBattle(room, battleOptions, {
		format,
		players: [],
		trainerSlots: [{
			slot: WILD_SLOT,
			name: `Wild ${wild.species}`,
			team: wildToTeam(wild, mod, catchRate),
		}],
		parent,
		title,
		mod,
		seed: options.prng.getSeed(),
	});
	battle.playerToken = player.token;
	battle.wild = wild;
	battle.playerSides = new Map([[0, player.token]]);

	room.game = battle;
	room.battle = battle;
	room.setParent(parent);

	battle.seatTrainers();
	battle.started = true;

	room.title = `${player.name} vs. wild ${wild.species}`;
	room.send(`|title|${room.title}`);
	room.add(
		Utils.html`|html|<div class="infobox">A wild encounter from ` +
		Utils.html`<a href="/${parent.roomid}">an adventure</a>. ` +
		`Only ${player.name} is fighting - the party is doing other things.</div>`
	).update();

	options.user.joinRoom(room);
	return battle;
}
