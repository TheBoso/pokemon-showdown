/**
 * Adventure - the room game
 *
 * A co-op playthrough of a Pokemon game. The adventure lives in its own
 * GameRoom and orchestrates everything that happens in it; battles are spawned
 * as sub-rooms parented to this one, the same way `BestOfGame` spawns its
 * games.
 *
 * This class is game-agnostic. Anything Emerald-specific - starters, the map,
 * trainers, encounters - comes from the `Campaign` it was created with, so
 * adding another game means adding a folder under `data/campaigns/`, not
 * touching this file.
 *
 * Two design points worth knowing before reading:
 *
 * - The UI is a chat page (`view-adventure-N`), pushed to each viewer, while
 *   the room itself is an ordinary chat room used for talking and for the
 *   event log. Nobody types a command; every command in the plugin exists to
 *   back a button on that page.
 *
 *   Two earlier surfaces were tried and rejected against the real client.
 *   `|controlshtml|` never reaches the DOM: it is queued into the battle's
 *   stepQueue, and the battle panel redraws its own replay controls over it as
 *   soon as that queue is non-empty. `|fieldhtml|` does render, but it shares
 *   the same queue, so every repaint appends a step that is never freed - an
 *   unbounded leak over an adventure that repaints on every vote. A page has
 *   neither problem, and carries no Showdown chrome of its own.
 *
 * - Players are identified by an opaque token, not a userid. Userids are not
 *   stable - a guest who picks a name becomes a different user - and keying a
 *   party to one would orphan it mid-run. This is what lets guests play.
 */

import { Utils } from '../../lib';
import { PRNG } from '../../sim/prng';
import { RoomGame, RoomGamePlayer } from '../room-game';
import { getCampaign, type Campaign, type TrainerData } from './campaigns';
import { allAdventures, deleteAdventure, saveAdventure } from './storage';
import { panel, type ViewerContext } from './render';
import { describeAll, meetsAll, unmet } from './progress';
import {
	createTrainerBattle, type BattleSideState, type BattleStateReport, type TrainerBattle,
} from './trainer-battle';
import { createWildBattle, WildBattle } from './wild-battle';
import { METHOD_INFO, methodsAt, rollEncounter, type SearchOption } from './encounters';
import { Vote, type VoteOption, type VoteResult } from './vote';
import { applyExp, evolve, expYield, forgetMove, maybeShedinja } from './progression';
import {
	createAdventureState, createPlayerState, createPokemon, displayName, healParty, isEveryoneWiped,
	type AdventurePlayerState, type AdventureState, type PartyPokemon, type Pending,
} from './state';

/** How long an untouched lobby sticks around before it cleans itself up. */
const LOBBY_TIMEOUT = 60 * 60 * 1000;

/** Long enough to talk it over, short enough that nobody wanders off. */
const TRAVEL_VOTE_MS = 45 * 1000;

/** Synthetic vote option id for healing rather than travelling. */
const HEAL_OPTION = 'heal';

/** Vote option id prefix for "fight this trainer". */
const FIGHT_PREFIX = 'fight:';

/**
 * How many players fight one trainer.
 *
 * Showdown allows two a side and no more (`format.playerCount`), so this is a
 * ceiling imposed by the simulator, not a design choice. Everyone else in the
 * adventure spectates the sub-room and keeps voting.
 */
const MAX_BATTLERS = 2;

/** What a battle reports when the simulator could not be asked. */
const EMPTY_REPORT: BattleStateReport = { sides: [], caught: null, balls: null };

/**
 * A player in the adventure.
 *
 * Deliberately thin: the durable per-player data lives in
 * `AdventurePlayerState`, keyed by token. This class is only the binding
 * between a currently-connected `User` and that state.
 */
export class AdventurePlayer extends RoomGamePlayer<Adventure> {
	/** Assigned by `Adventure#addPlayer` immediately after construction. */
	token = '';

	get state(): AdventurePlayerState | undefined {
		return this.game.state.players[this.token];
	}
}

export class Adventure extends RoomGame<AdventurePlayer> {
	override readonly gameid = 'adventure' as ID;
	/**
	 * Renaming is safe: state is keyed by token, and `onRename` remaps the
	 * userid binding. A guest picking a name keeps their party.
	 */
	override allowRenames = true;

	state: AdventureState;
	campaign: Campaign;
	prng: PRNG;
	timeoutTimer: NodeJS.Timeout | null = null;
	/** The open vote, if any. Transient - never persisted. */
	vote: Vote | null = null;
	/** The live battle sub-room, if one is running. */
	battleRoomid: RoomID | null = null;
	/**
	 * Who that battle is against, so its result can be recorded.
	 *
	 * Usually one, but two when a pair of trainers had to be put together to
	 * fill a multi battle's four slots - and then beating them clears both.
	 */
	battleTrainerIds: string[] = [];
	/** Tokens of whoever is fighting it, so a loss can be applied to them. */
	battlePlayers: string[] = [];
	/**
	 * Live wild encounters, by player token.
	 *
	 * Wild battles are personal and unsynced - everyone searches on their own
	 * button - so several run at once and none of them touches `phase`. This map
	 * exists to stop one player having two open at the same time, which is the
	 * only way the button could be abused.
	 */
	wildBattles = new Map<string, RoomID>();

	constructor(room: Room, state: AdventureState, campaign: Campaign) {
		super(room);
		this.state = state;
		this.campaign = campaign;
		this.title = campaign.name;
		this.prng = new PRNG(state.seed);

		// Restored adventures already have players; re-bind anyone who is online.
		for (const token of state.playerOrder) {
			const playerState = state.players[token];
			if (!playerState) continue;
			const user = Users.getExact(playerState.userid);
			if (!user) continue;
			const player = super.addPlayer(user);
			if (player) player.token = token;
		}

		this.pokeTimeout();
	}

	/* -------------------------------------------------------------- *
	 * Creation and restoration
	 * -------------------------------------------------------------- */

	/**
	 * Deliberately not prefixed `game-` or `battle-`: the client routes those
	 * to its battle panel, which brings replay controls and the stepQueue with
	 * it. A plain roomid gets a plain chat room.
	 *
	 * The roomid doubles as the page id, so the adventure in `adventure-3` has
	 * its panel at `view-adventure-3`.
	 */
	static nextRoomid(): RoomID {
		let num = 1;
		while (Rooms.get(`adventure-${num}` as RoomID)) num++;
		return `adventure-${num}` as RoomID;
	}

	/** The chat page this adventure's UI lives on, without the `view-` prefix. */
	get pageid(): string {
		return this.roomid;
	}

	/** Creates a brand new adventure and drops the host into it. */
	static create(user: User, campaign: Campaign): Adventure {
		const roomid = Adventure.nextRoomid();
		const room = Rooms.createChatRoom(roomid, campaign.name, {
			// Not `isPersonal`: personal rooms deallocate when idle, and an
			// adventure is allowed to sit quiet without being destroyed.
			isPrivate: 'hidden',
			modjoin: null,
		});

		const state = createAdventureState(roomid, campaign);
		const game = new Adventure(room, state, campaign);
		room.game = game;

		const player = game.addPlayer(user);
		if (player) state.host = player.token;
		user.joinRoom(room);
		game.save();
		game.update();
		return game;
	}

	/** Rebuilds an adventure room from disk after a restart. */
	static restore(state: AdventureState): Adventure | null {
		if (Rooms.get(state.roomid)) return null;

		const campaign = getCampaign(state.campaign);
		if (!campaign) {
			Monitor.error(
				`Adventure ${state.roomid} needs campaign "${state.campaign}", which isn't installed; skipping.`
			);
			return null;
		}

		try {
			const room = Rooms.createChatRoom(state.roomid, campaign.name, {
				isPrivate: 'hidden',
				modjoin: null,
			});
			const game = new Adventure(room, state, campaign);
			room.game = game;
			game.update();
			// A vote is transient, so a restored adventure has none. Reopen one
			// rather than leaving the party stranded with no way to move.
			if (!['lobby', 'ended'].includes(state.phase)) {
				process.nextTick(() => game.openTravelVote());
			}
			return game;
		} catch (err: any) {
			Monitor.crashlog(err, 'Adventure restore', { roomid: state.roomid });
			return null;
		}
	}

	/** Restores every stored adventure. Called once, when the plugin loads. */
	static restoreAll(): void {
		for (const state of allAdventures()) {
			Adventure.restore(state);
		}
	}

	override makePlayer(user: User): AdventurePlayer {
		return new AdventurePlayer(user, this, this.players.length + 1);
	}

	/* -------------------------------------------------------------- *
	 * Identity
	 * -------------------------------------------------------------- */

	/** The player state for a user, if they're in this adventure. */
	playerStateFor(user: User): AdventurePlayerState | null {
		const token = this.state.playerTokens[user.id];
		return (token && this.state.players[token]) || null;
	}

	override addPlayer(user: User): AdventurePlayer | null {
		const player = super.addPlayer(user);
		if (!player) return null;

		// Reclaim an existing slot where possible, so rejoining keeps the party.
		let token = this.state.playerTokens[user.id];
		if (!token || !this.state.players[token]) {
			const playerState = createPlayerState(user, this.campaign);
			token = playerState.token;
			this.state.players[token] = playerState;
			this.state.playerOrder.push(token);
		} else {
			this.state.players[token].userid = user.id;
			this.state.players[token].name = user.name;
		}

		this.state.playerTokens[user.id] = token;
		player.token = token;
		this.room.auth.set(user.id, Users.PLAYER_SYMBOL);
		return player;
	}

	/**
	 * Keeps the userid binding pointing at the right token when someone
	 * renames - most often a guest choosing a name mid-adventure.
	 */
	override onRename(user: User, oldUserid: ID, isJoining: boolean, isForceRenamed: boolean): void {
		const player = this.playerTable[oldUserid];
		if (!player) {
			super.onRename(user, oldUserid, isJoining, isForceRenamed);
			// Signing in as a name that already owns a party in this run is the
			// *other* direction of the same idea: not a spectator picking a name,
			// but a player coming back to their own adventure. This is the usual
			// way it happens - a client reconnects as a guest first and renames a
			// moment later, so the room was joined by somebody who wasn't yet Dom.
			if (this.rebindReturningPlayer(user)) this.update();
			return;
		}

		// Re-key the player table ourselves rather than deferring to the base
		// class, which skips the rename when the user ends up unnamed. Skipping
		// would leave `playerTable` on the old userid while `playerTokens` moved
		// to the new one, and the two must not disagree.
		this.renamePlayer(user, oldUserid);

		const token = player.token;
		if (this.state.playerTokens[oldUserid] === token) {
			delete this.state.playerTokens[oldUserid];
		}
		this.state.playerTokens[user.id] = token;

		const playerState = this.state.players[token];
		if (playerState) {
			playerState.userid = user.id;
			playerState.name = user.name;
		}

		this.save();
		this.update();
	}

	/* -------------------------------------------------------------- *
	 * Joining and leaving
	 * -------------------------------------------------------------- */

	/**
	 * Re-attaches a returning player to the party they already have.
	 *
	 * `joinGame` is shut once a run starts, and the constructor can only rebind
	 * players who happened to be online at the moment the room was restored -
	 * which, after a restart, is nobody. Without this the adventure comes back
	 * exactly as promised and then refuses every command from the people who
	 * were playing it, because `playerTable` is empty.
	 *
	 * Only ever re-attaches: someone with no token is a spectator and stays one.
	 *
	 * Called from both entry points, because they are genuinely separate: the
	 * panel is a *page*, and opening a page does not join the room, so a player
	 * who clicks straight back to `view-adventure-N` never triggers the room's
	 * connect hook and would sit there being told they are spectating their own
	 * adventure.
	 */
	private rebindReturningPlayer(user: User): boolean {
		if (this.playerTable[user.id]) return false;
		const token = this.state.playerTokens[user.id];
		if (!token || !this.state.players[token]) return false;
		if (!this.addPlayer(user)) return false;

		this.save();
		return true;
	}

	override joinGame(user: User): void {
		if (this.state.phase !== 'lobby') {
			throw new Chat.ErrorMessage(`This adventure has already started.`);
		}
		if (this.playerTable[user.id]) {
			throw new Chat.ErrorMessage(`You have already joined this adventure.`);
		}

		const player = this.addPlayer(user);
		if (!player) throw new Chat.ErrorMessage(`You could not be added to this adventure.`);
		if (!this.state.host) this.state.host = player.token;

		this.room.add(Utils.html`|c|~|${user.name} joined the adventure.`);
		this.save();
		this.update();
	}

	override leaveGame(user: User): void {
		const player = this.playerTable[user.id];
		if (!player) throw new Chat.ErrorMessage(`You are not in this adventure.`);
		if (this.state.phase !== 'lobby') {
			throw new Chat.ErrorMessage(
				`You can't leave an adventure once it has started - use the End button to stop it.`
			);
		}

		const token = player.token;
		this.vote?.withdraw(token);
		this.removePlayer(player);
		delete this.state.players[token];
		delete this.state.playerTokens[user.id];
		this.state.playerOrder = this.state.playerOrder.filter(entry => entry !== token);
		this.room.auth.set(user.id, '+');

		this.room.add(Utils.html`|c|~|${user.name} left the adventure.`);

		// The host leaving hands the adventure to whoever is next in line.
		if (this.state.host === token) {
			this.state.host = this.state.playerOrder[0] || '';
			const newHost = this.state.players[this.state.host];
			if (newHost) this.room.add(Utils.html`|c|~|${newHost.name} is now the host.`);
		}

		this.save();
		this.update();
	}

	/* -------------------------------------------------------------- *
	 * Lobby
	 * -------------------------------------------------------------- */

	pickStarter(user: User, speciesid: string): void {
		const player = this.playerTable[user.id];
		if (!player) throw new Chat.ErrorMessage(`You are not in this adventure.`);
		if (this.state.phase !== 'lobby') {
			throw new Chat.ErrorMessage(`Starters can only be chosen before the adventure starts.`);
		}

		const starters = this.campaign.manifest.starters;
		const starter = starters.find(option => toID(option.species) === toID(speciesid));
		if (!starter) {
			const names = starters.map(option => option.species).join(', ');
			throw new Chat.ErrorMessage(`"${speciesid}" isn't a starter in ${this.campaign.name}. Choose from: ${names}.`);
		}

		const playerState = player.state;
		if (!playerState) throw new Chat.ErrorMessage(`Your adventure data is missing.`);
		if (playerState.party.length) {
			throw new Chat.ErrorMessage(`You have already chosen ${playerState.party[0].species}.`);
		}

		playerState.party.push(createPokemon({
			campaign: this.campaign,
			species: starter.species,
			level: this.campaign.manifest.starterLevel,
			prng: this.prng,
			trainer: playerState.token as ID,
			location: this.state.location,
		}));

		// The PRNG advanced, so the stored seed has to advance with it or a
		// restored adventure would replay the same rolls.
		this.state.seed = this.prng.getSeed();

		this.room.add(Utils.html`|c|~|${user.name} chose ${starter.species}!`);
		this.save();
		this.update();
	}

	start(user: User): void {
		const player = this.playerTable[user.id];
		if (!player || player.token !== this.state.host) {
			throw new Chat.ErrorMessage(`Only the host can start the adventure.`);
		}
		if (this.state.phase !== 'lobby') {
			throw new Chat.ErrorMessage(`This adventure has already started.`);
		}

		const players = this.state.playerOrder.map(token => this.state.players[token]).filter(Boolean);
		if (!players.length) throw new Chat.ErrorMessage(`Nobody has joined the adventure yet.`);

		const waiting = players.filter(entry => !entry.party.length);
		if (waiting.length) {
			const names = waiting.map(entry => entry.name).join(', ');
			throw new Chat.ErrorMessage(`Still waiting on a starter from: ${names}.`);
		}

		this.state.phase = 'overworld';
		const start = this.campaign.location(this.state.location);
		const where = start?.name || this.state.location;

		this.room.add(`|html|<div class="broadcast-green"><strong>The adventure has begun!</strong></div>`);
		this.room.add(Utils.html`|html|<div class="infobox">You set out from ${where}.</div>`);

		this.save();
		this.openTravelVote();
	}

	/* -------------------------------------------------------------- *
	 * Travel
	 * -------------------------------------------------------------- */

	get here() {
		return this.campaign.location(this.state.location);
	}

	/**
	 * Builds the ballot for the current location: every exit, plus healing if
	 * there is a Pokemon Centre here.
	 *
	 * Locked exits stay on the ballot rather than being hidden. Showing a road
	 * you cannot take yet, and why, is how a player learns the map; hiding it
	 * just makes the world feel arbitrarily small.
	 */
	/** Trainers at the current location who have not been beaten yet. */
	remainingTrainers(): { id: string, trainer: TrainerData }[] {
		return this.campaign.trainersAt(this.state.location)
			.filter(entry => !this.state.defeatedTrainers.includes(entry.id));
	}

	/**
	 * Who the party would actually face if they took this fight.
	 *
	 * A multi battle needs four filled slots, so two players against a trainer
	 * with a single Pokemon means bringing the next trainer along too. Shared
	 * by the ballot and the battle, so the button cannot promise one opponent
	 * and the fight deliver two.
	 */
	trainerLineup(
		lead: { id: string, trainer: TrainerData }, battlers: number
	): { id: string, trainer: TrainerData }[] {
		if (battlers < 2 || lead.trainer.team.length >= 2) return [lead];
		const partner = this.remainingTrainers().find(candidate => candidate.id !== lead.id);
		return partner ? [lead, partner] : [lead];
	}

	travelOptions(): VoteOption[] {
		const options: VoteOption[] = [];
		const here = this.here;
		const remaining = this.remainingTrainers();
		// With every party down there is no gauntlet to fight, so it must not
		// bar the road either - otherwise a wiped party on a route with no way
		// back would have no legal move at all.
		const canFight = !!this.electBattlers(1).length;

		// The gauntlet comes first: while anyone is left standing, fighting them
		// is the only way forward.
		if (remaining.length) {
			const next = remaining[0];
			const lineup = this.trainerLineup(next, this.electBattlers().length);
			const label = lineup
				.map(candidate => `${candidate.trainer.trainerClass} ${candidate.trainer.name}`)
				.join(' & ');
			options.push({
				id: `${FIGHT_PREFIX}${next.id}`,
				label: `Battle ${label}`,
				detail: lineup.length > 1 ?
					`both at once - ${remaining.length} left here` :
					(remaining.length > 1 ? `${remaining.length} trainers left here` : `last one here`),
				locked: canFight ? undefined : `nobody has a Pokemon left`,
			});
		}

		if (here?.pokecenter) {
			const hurt = this.playersNeedingHealing();
			options.push({
				id: HEAL_OPTION,
				label: `Pokemon Centre`,
				detail: hurt ? `heal ${hurt} part${hurt === 1 ? 'y' : 'ies'}` : `everyone is already healthy`,
			});
		}

		for (const exit of this.campaign.exits(this.state.location)) {
			const missing = unmet(this.state.progress, exit.requires);

			// Trainers block the way onward, never the way back. Retreating to
			// heal has to stay possible or a battered party is simply stuck.
			const blockedByTrainers = !!remaining.length && canFight && exit.id !== this.state.cameFrom;

			let locked;
			if (missing.length) {
				locked = `needs ${describeAll(missing)}`;
			} else if (blockedByTrainers) {
				locked = remaining.length === 1 ? `1 trainer still here` : `${remaining.length} trainers still here`;
			}

			options.push({
				id: exit.id,
				label: exit.location.name,
				detail: exit.id === this.state.cameFrom && remaining.length ?
					'back the way you came' :
					(this.state.visited.includes(exit.id) ? undefined : 'somewhere new'),
				locked,
			});
		}
		return options;
	}

	playersNeedingHealing(): number {
		return this.state.playerOrder.filter(token => {
			const player = this.state.players[token];
			return player?.party.some(pokemon => pokemon.hp < pokemon.maxhp || pokemon.status);
		}).length;
	}

	openTravelVote(): void {
		if (this.ended) return;
		this.vote?.destroy();

		const options = this.travelOptions();
		if (!options.some(option => !option.locked)) {
			// Every road out is shut. Possible if a campaign gates badly; say so
			// rather than opening a vote nobody can answer.
			this.vote = null;
			this.room.add(
				`|html|<div class="broadcast-red">There is nowhere to go from here that the party can reach.</div>`
			).update();
			this.update();
			return;
		}

		this.vote = new Vote({
			title: `Where next?`,
			options,
			durationMs: TRAVEL_VOTE_MS,
			onTick: () => this.update(),
			onResolve: result => this.onTravelVote(result),
			pick: items => this.prng.sample(items),
		});
		this.update();
	}

	castVote(user: User, optionId: string): void {
		const player = this.playerTable[user.id];
		if (!player) throw new Chat.ErrorMessage(`You are not in this adventure.`);
		if (!this.vote) throw new Chat.ErrorMessage(`There is nothing to vote on right now.`);

		const option = this.vote.options.find(entry => entry.id === toID(optionId) || entry.id === optionId);
		if (!option) throw new Chat.ErrorMessage(`That isn't one of the options.`);
		if (option.locked) throw new Chat.ErrorMessage(`${option.label} is closed: ${option.locked}.`);

		if (!this.vote.cast(player.token, option.id)) {
			throw new Chat.ErrorMessage(`Your vote could not be recorded.`);
		}

		this.update();
		this.vote.maybeResolveEarly(this.state.playerOrder.length);
	}

	private onTravelVote(result: VoteResult): void {
		this.vote = null;
		if (this.ended) return;

		if (result.tied) {
			this.room.add(Utils.html`|html|<div class="infobox">The vote tied - ${result.winner.label} it is.</div>`);
		}

		if (result.winner.id === HEAL_OPTION) {
			this.healEveryone();
			return;
		}
		if (result.winner.id.startsWith(FIGHT_PREFIX)) {
			this.startTrainerBattle(result.winner.id.slice(FIGHT_PREFIX.length));
			return;
		}
		this.travelTo(result.winner.id);
	}

	/* -------------------------------------------------------------- *
	 * Trainer battles
	 * -------------------------------------------------------------- */

	/**
	 * Chooses who fights, by rotation: fewest battles first, oldest turn next.
	 *
	 * Rotating rather than voting keeps everyone involved without another
	 * ballot before every fight, and stops one confident player monopolising
	 * the run. Anyone whose party is wiped sits out - they have nothing to send.
	 */
	electBattlers(limit = MAX_BATTLERS): AdventurePlayerState[] {
		return this.state.playerOrder
			.map(token => this.state.players[token])
			.filter(player => player?.party.some(pokemon => pokemon.hp > 0))
			.sort((a, b) => (a.battlesFought - b.battlesFought) || (a.lastBattleAt - b.lastBattleAt))
			.slice(0, limit);
	}

	startTrainerBattle(trainerId: string): void {
		const entry = this.campaign.trainersAt(this.state.location)
			.find(candidate => candidate.id === trainerId);
		if (!entry) {
			Monitor.error(`Adventure ${this.roomid}: no trainer "${trainerId}" at ${this.state.location}`);
			this.openTravelVote();
			return;
		}

		const battlers = this.electBattlers();
		if (!battlers.length) {
			this.room.add(
				`|html|<div class="broadcast-red">Nobody has a Pokemon left to fight with.</div>`
			).update();
			this.openTravelVote();
			return;
		}

		let online = battlers
			.map(player => ({ player, user: Users.getExact(player.userid) }))
			.filter((pair): pair is { player: AdventurePlayerState, user: User } => !!pair.user);
		if (!online.length) {
			this.room.add(
				`|html|<div class="broadcast-red">The chosen battlers are offline; try again.</div>`
			).update();
			this.openTravelVote();
			return;
		}

		/*
		 * Two players means a multi battle, and a multi battle needs all four
		 * slots filled - the simulator waits for `>player p4` and never starts
		 * without it, silently. A trainer with two or more Pokemon covers both
		 * slots alone; a trainer with only one (36% of Emerald's) cannot, and
		 * has to bring somebody with them.
		 *
		 * Pairing them with the next trainer on the route is what Emerald does
		 * for its own tag battles, and it beats the alternatives: handing a
		 * trainer a second Pokemon they do not own, or making the two players
		 * take turns while the other watches.
		 */
		const lineup = this.trainerLineup(entry, online.length);
		if (online.length > 1 && lineup.length < 2) {
			// The last trainer on a route, one Pokemon, nobody to stand beside
			// them. Fought one-on-one rather than not at all.
			online = online.slice(0, 1);
		}

		const battle = createTrainerBattle({
			parent: this.room,
			campaign: this.campaign,
			trainers: lineup.map(candidate => candidate.trainer),
			players: online,
			seed: this.prng.getSeed(),
		});
		if (!battle) {
			this.room.add(`|html|<div class="broadcast-red">That battle could not be started.</div>`).update();
			this.openTravelVote();
			return;
		}

		this.state.phase = 'battle';
		this.battleRoomid = battle.roomid;
		this.battleTrainerIds = lineup.map(candidate => candidate.id);
		this.battlePlayers = online.map(pair => pair.player.token);
		for (const { player } of online) {
			player.battlesFought++;
			player.lastBattleAt = Date.now();
		}

		const names = online.map(pair => pair.player.name).join(' and ');
		const against = lineup
			.map(candidate => `${candidate.trainer.trainerClass} ${candidate.trainer.name}`)
			.join(' and ');
		this.room.add(
			Utils.html`|html|<div class="infobox"><strong>${names}</strong> take on ` +
			Utils.html`${against}! ` +
			`<a href="/${battle.roomid}">Watch</a></div>`
		);
		this.save();
		this.update();
	}

	/**
	 * Called by `RoomBattle` on the parent room's game when a sub-battle ends.
	 *
	 * The trainer counts as beaten only if a human side won: a loss or a tie
	 * leaves them standing, so the party has to regroup and come back.
	 */
	override onBattleWin(room: GameRoom, winnerid: ID): void {
		if (this.ended) return;

		const game = room.game;
		const isWild = game instanceof WildBattle;
		if (!isWild && room.roomid !== this.battleRoomid) return;

		// Ask the simulator for its final HP, status and PP before deciding
		// anything: whether anyone can still fight, and whether the run wipes,
		// both depend on it. `RoomBattleStream` is keepAlive, so the battle is
		// still answerable after it has ended.
		const battle = game as TrainerBattle | undefined;
		const finish = (report: BattleStateReport) => {
			if (isWild) this.finishWildBattle(room, battle as WildBattle, report);
			else this.finishBattle(room, winnerid, battle, report);
		};

		if (typeof battle?.requestState === 'function') {
			void battle.requestState().then(finish, () => finish(EMPTY_REPORT));
			return;
		}
		finish(EMPTY_REPORT);
	}

	private finishBattle(
		room: GameRoom, winnerid: ID, battle: TrainerBattle | undefined, report: BattleStateReport
	): void {
		if (this.ended || room.roomid !== this.battleRoomid) return;
		this.battleRoomid = null;

		// EXP first: the payout is matched to the team by position, and the team
		// was built from whoever was standing when the battle began. Absorbing
		// the result flattens fainted party members to 0 HP, which changes that
		// list - so read it while it still means what it meant at the start.
		const sent = battle && this.sentLists(battle);

		// Carry damage, status and PP out of the battle before deciding
		// anything: a party that limped out at 2 HP is not the same as one that
		// walked out untouched.
		if (battle && report.sides.length) this.absorbBattleState(battle, report.sides);
		if (battle && sent) this.awardExp(battle, sent, true);

		const trainerIds = this.battleTrainerIds;
		const battlers = this.battlePlayers;
		this.battleTrainerIds = [];
		this.battlePlayers = [];
		const won = !!winnerid && !!this.state.playerTokens[winnerid];

		if (won && trainerIds.length) {
			// A tag pair goes down together: they were one fight.
			const beaten: string[] = [];
			for (const trainerId of trainerIds) {
				if (this.state.defeatedTrainers.includes(trainerId)) continue;
				this.state.defeatedTrainers.push(trainerId);
				beaten.push(this.campaign.trainer(trainerId)?.name || 'The trainer');
			}
			if (beaten.length) {
				this.room.add(
					Utils.html`|html|<div class="broadcast-green">${beaten.join(' and ')} ` +
					`${beaten.length > 1 ? 'were' : 'was'} defeated!</div>`
				);
			}
		} else {
			this.applyDefeat(battlers);
		}

		const here = this.here;
		this.state.phase = ['town', 'city'].includes(here?.kind || '') ? 'overworld' : 'route';
		this.save();

		// A wipe rewrites where everyone is, so resolve it before reopening the
		// vote - otherwise the ballot would be for the location they just left.
		if (isEveryoneWiped(this.state)) {
			this.whiteOut();
			return;
		}
		this.openTravelVote();
	}

	/**
	 * Writes the simulator's final HP, status and PP back onto the parties.
	 *
	 * Matched by position: the team handed to a side was built from that
	 * player's living party in order, so side.pokemon[i] is that same Pokemon.
	 * Fainted party members were left out of the team, so they are skipped here
	 * too and keep their 0 HP.
	 */
	private absorbBattleState(battle: TrainerBattle, sides: BattleSideState[][]): void {
		for (const [sideIndex, token] of battle.playerSides) {
			const player = this.state.players[token];
			const condition = sides[sideIndex];
			if (!player || !condition) continue;

			const sent = player.party.filter(pokemon => pokemon.hp > 0);
			for (const [index, pokemon] of sent.entries()) {
				const after = condition[index];
				if (!after) continue;

				pokemon.hp = after.fainted ? 0 : Math.max(0, Math.min(after.hp, pokemon.maxhp));
				pokemon.status = (after.fainted ? '' : after.status || '') as PartyPokemon['status'];
				pokemon.sleepTurns = pokemon.status === 'slp' ? after.statusTurns || 0 : 0;

				if (Array.isArray(after.pp)) {
					for (let slot = 0; slot < pokemon.pp.length; slot++) {
						if (typeof after.pp[slot] === 'number') pokemon.pp[slot] = after.pp[slot];
					}
				}
			}
		}
	}

	/* -------------------------------------------------------------- *
	 * EXP and levelling
	 * -------------------------------------------------------------- */

	/**
	 * The party members each side actually took into the battle, in team order.
	 *
	 * This is the same list `partyToTeam` built when the battle started, so a
	 * team index from the simulator indexes straight into it. It must be taken
	 * *before* the battle result is absorbed, because absorbing knocks fainted
	 * members down to 0 HP and the list is defined by who had HP.
	 */
	private sentLists(battle: TrainerBattle): Map<number, PartyPokemon[]> {
		const lists = new Map<number, PartyPokemon[]>();
		for (const [sideIndex, token] of battle.playerSides) {
			const player = this.state.players[token];
			if (player) lists.set(sideIndex, player.party.filter(pokemon => pokemon.hp > 0));
		}
		return lists;
	}

	/**
	 * Pays out everything the battle earned, and queues whatever that raises.
	 *
	 * Reported per Pokemon rather than per knockout: a six-trainer gauntlet
	 * produces a dozen payouts, and "Torchic gained 240 EXP and grew to Lv14"
	 * is the part anyone reads.
	 */
	private awardExp(battle: TrainerBattle, sent: Map<number, PartyPokemon[]>, fromTrainer: boolean): void {
		interface Tally {
			player: AdventurePlayerState;
			pokemon: PartyPokemon;
			gained: number;
			startLevel: number;
			learned: string[];
		}
		const tallies = new Map<string, Tally>();

		for (const event of battle.expEvents) {
			const winners: { player: AdventurePlayerState, pokemon: PartyPokemon }[] = [];
			for (const key of event.participants) {
				const [sideIndex, teamIndex] = key.split(':').map(Number);
				const token = battle.playerSides.get(sideIndex);
				const player = token ? this.state.players[token] : null;
				const pokemon = sent.get(sideIndex)?.[teamIndex];
				if (player && pokemon) winners.push({ player, pokemon });
			}
			if (!winners.length) continue;

			const gained = expYield(
				this.campaign,
				{ species: event.species, level: event.level, fromTrainer },
				winners.length
			);

			for (const { player, pokemon } of winners) {
				let tally = tallies.get(pokemon.uid);
				if (!tally) {
					tally = { player, pokemon, gained: 0, startLevel: pokemon.level, learned: [] };
					tallies.set(pokemon.uid, tally);
				}

				const result = applyExp(this.campaign, pokemon, gained);
				tally.gained += gained;
				tally.learned.push(...result.learned);
				for (const entry of result.pending) this.queuePending(player, entry);
			}
		}

		for (const tally of tallies.values()) {
			this.reportExp(tally.player, tally.pokemon, tally.gained, tally.startLevel, tally.learned);
		}
	}

	private reportExp(
		player: AdventurePlayerState, pokemon: PartyPokemon, gained: number,
		startLevel: number, learned: string[]
	): void {
		const dex = Dex.mod(this.campaign.mod);
		let line = Utils.html`<strong>${displayName(pokemon)}</strong> gained ${gained} EXP`;
		if (pokemon.level > startLevel) {
			line += Utils.html` and grew to Lv${pokemon.level}`;
		}
		line += `.`;
		for (const moveid of learned) {
			line += Utils.html` It learned ${dex.moves.get(moveid).name}!`;
		}

		this.room.add(
			Utils.html`|html|<div class="infobox"><small>${player.name}:</small> ` + line + `</div>`
		);
	}

	/**
	 * Adds a decision to a player's queue, unless it is already there.
	 *
	 * The same question can be raised twice - a Pokemon that levels past its
	 * evolution point in two consecutive battles, a move offered again after
	 * being declined - and asking twice is noise, not a second chance.
	 */
	private queuePending(player: AdventurePlayerState, entry: Pending): void {
		player.pending ||= [];
		const duplicate = player.pending.some(existing => (
			existing.kind === entry.kind && existing.uid === entry.uid &&
			(entry.kind === 'evolve' || (existing as any).move === (entry as any).move)
		));
		if (!duplicate) player.pending.push(entry);
	}

	/**
	 * You lose a Pokemon battle when your last Pokemon faints, so the losing
	 * side's parties are wiped out rather than merely bruised.
	 *
	 * Without this a loss costs nothing: the same trainer could be re-fought at
	 * full health forever, and the Pokemon Centre would be decoration.
	 */
	private applyDefeat(battlers: string[]): void {
		const names: string[] = [];
		for (const token of battlers) {
			const player = this.state.players[token];
			if (!player) continue;
			for (const pokemon of player.party) {
				pokemon.hp = 0;
				pokemon.status = '';
				pokemon.sleepTurns = 0;
			}
			names.push(player.name);
		}

		const who = names.length ? Utils.escapeHTML(names.join(' and ')) : `The party`;
		this.room.add(
			`|html|<div class="broadcast-red">${who} lost. ` +
			`Their Pokemon have fainted, and that trainer is still standing.</div>`
		);
	}

	/* -------------------------------------------------------------- *
	 * Wild encounters
	 *
	 * Deliberately outside the phase machine. Searching is a personal act on a
	 * personal button, several players can be mid-encounter at once, and the
	 * group's vote carries on regardless - so none of this touches `phase` or
	 * `vote`. That is the whole point of "not synced".
	 * -------------------------------------------------------------- */

	/** The search buttons one player should see here, and why any are shut. */
	searchOptions(player: AdventurePlayerState): SearchOption[] {
		if (['lobby', 'ended'].includes(this.state.phase)) return [];

		const busy = this.wildBattles.has(player.token);
		const canFight = player.party.some(pokemon => pokemon.hp > 0);

		return methodsAt(this.campaign, this.state.location).map(method => {
			const info = METHOD_INFO[method];
			const missing = info.requires ? unmet(this.state.progress, [info.requires]) : [];

			let locked;
			if (missing.length) locked = `needs ${describeAll(missing)}`;
			else if (busy) locked = `you're already in an encounter`;
			else if (!canFight) locked = `your Pokemon have all fainted`;

			return { method, label: info.label, locked };
		});
	}

	/**
	 * One player looks for a wild Pokemon.
	 *
	 * Most searches find nothing - that is the ROM's own encounter rate, not a
	 * failure - so a miss is reported to that player alone and costs nothing.
	 */
	search(user: User, method: string): void {
		const gamePlayer = this.playerTable[user.id];
		const player = gamePlayer?.state;
		if (!player) throw new Chat.ErrorMessage(`You are not in this adventure.`);

		const option = this.searchOptions(player).find(entry => entry.method === method);
		if (!option) throw new Chat.ErrorMessage(`There is nothing to search for here.`);
		if (option.locked) throw new Chat.ErrorMessage(`You can't do that: ${option.locked}.`);

		const encounter = rollEncounter(this.campaign, this.state.location, method, this.prng);
		// The roll happened either way, so the seed moves either way - otherwise
		// a restart would replay the same misses.
		this.state.seed = this.prng.getSeed();

		if (!encounter) {
			this.room.sendUser(
				user,
				`|html|<div class="infobox"><small>You search, and find nothing this time.</small></div>`
			);
			this.save();
			return;
		}

		const battle = createWildBattle({
			parent: this.room,
			campaign: this.campaign,
			player,
			user,
			encounter,
			prng: this.prng,
			location: this.state.location,
		});
		this.state.seed = this.prng.getSeed();

		if (!battle) {
			this.room.sendUser(user, `|html|<div class="message-error">That encounter could not be started.</div>`);
			this.save();
			return;
		}

		this.wildBattles.set(player.token, battle.roomid);
		this.room.add(
			Utils.html`|html|<div class="infobox">${player.name} ran into a wild ` +
			Utils.html`<strong>${battle.wild.species}</strong> (Lv${battle.wild.level}). ` +
			`<a href="/${battle.roomid}">Watch</a></div>`
		);
		this.save();
		this.update();
	}

	/**
	 * A wild encounter is over: bank the damage, the balls spent, and anything
	 * caught.
	 *
	 * The caught Pokemon is the exact individual that was fought, carried on the
	 * battle since before it started - not a fresh roll of the same species.
	 */
	private finishWildBattle(room: GameRoom, battle: WildBattle | undefined, report: BattleStateReport): void {
		if (this.ended || !battle) return;

		const token = battle.playerToken;
		if (this.wildBattles.get(token) === room.roomid) this.wildBattles.delete(token);

		const player = this.state.players[token];
		if (!player) return;

		const sent = this.sentLists(battle);
		if (report.sides.length) this.absorbBattleState(battle, report.sides);
		// Catching pays nothing - the wild Pokemon is fainted off the field to
		// end the battle, but it was captured, not beaten. Emerald is explicit
		// about this and it is what stops a Master Ball being an EXP button.
		if (!report.caught) this.awardExp(battle, sent, false);

		// The bag is authoritative inside the battle while balls are being
		// thrown, so it comes back rather than being decremented by guesswork.
		if (report.balls) {
			for (const itemid in report.balls) player.bag[itemid] = report.balls[itemid];
		}

		if (report.caught) {
			this.addCaught(player, battle, report.caught);
		} else if (player.party.every(pokemon => pokemon.hp <= 0)) {
			this.room.add(
				Utils.html`|html|<div class="broadcast-red">${player.name}'s Pokemon were beaten by the ` +
				Utils.html`wild ${battle.wild.species}.</div>`
			);
		}

		this.save();

		if (isEveryoneWiped(this.state)) {
			this.whiteOut();
			return;
		}
		this.update();
	}

	/** Moves a caught Pokemon into the party, or the box when the party is full. */
	private addCaught(
		player: AdventurePlayerState, battle: WildBattle, caught: { species: string, level: number, hp?: number }
	): void {
		const pokemon = battle.wild;
		pokemon.originalTrainer = player.token as ID;
		pokemon.caughtAt = this.state.location;
		// It was fainted to get it off the field; it is not actually hurt that
		// badly. `hp` is what it had at the moment the ball landed.
		pokemon.hp = Math.max(1, Math.min(caught.hp ?? pokemon.maxhp, pokemon.maxhp));

		const boxed = player.party.length >= this.campaign.manifest.maxPartySize;
		(boxed ? player.box : player.party).push(pokemon);

		this.room.add(
			Utils.html`|html|<div class="broadcast-green">${player.name} caught a ` +
			Utils.html`${pokemon.shiny ? 'shiny ' : ''}${pokemon.species}!</div>`
		);
		if (boxed) {
			this.room.add(
				Utils.html`|html|<div class="infobox"><small>${player.name}'s party is full, so it went ` +
				`to the box.</small></div>`
			);
		}
	}

	/* -------------------------------------------------------------- *
	 * Party management
	 *
	 * The box is not a filing cabinet: catching with a full party puts a
	 * Pokemon there, so without a way to swap one back out, catching past six
	 * would be catching into a hole.
	 * -------------------------------------------------------------- */

	/**
	 * True while this player's party is committed to a live battle.
	 *
	 * A team crosses into the battle process once, at the start, and the result
	 * is matched back onto the party by position (`absorbBattleState`). Boxing
	 * or reordering in between would land the simulator's HP on the wrong
	 * Pokemon - silently, and only visible several battles later.
	 */
	isBattling(token: string): boolean {
		return this.wildBattles.has(token) || this.battlePlayers.includes(token);
	}

	/**
	 * The player behind a personal action, once it is established they are
	 * allowed to take one. `doing` completes "You can't ... in a battle".
	 */
	private actingPlayer(user: User, doing: string): AdventurePlayerState {
		const player = this.playerTable[user.id]?.state;
		if (!player) throw new Chat.ErrorMessage(`You are not in this adventure.`);
		if (this.state.phase === 'lobby') {
			throw new Chat.ErrorMessage(`The adventure hasn't started yet.`);
		}
		if (this.isBattling(player.token)) {
			throw new Chat.ErrorMessage(`You can't ${doing} in the middle of a battle.`);
		}
		return player;
	}

	/** Finds one of a player's Pokemon by uid, in the party or the box. */
	private findPokemon(
		player: AdventurePlayerState, uid: string
	): { pokemon: PartyPokemon, list: PartyPokemon[], index: number } | null {
		for (const list of [player.party, player.box]) {
			const index = list.findIndex(pokemon => pokemon.uid === uid);
			if (index >= 0) return { pokemon: list[index], list, index };
		}
		return null;
	}

	/** Party -> box. */
	deposit(user: User, uid: string): void {
		const player = this.actingPlayer(user, `change your party`);
		const found = this.findPokemon(player, uid);
		if (!found || found.list !== player.party) {
			throw new Chat.ErrorMessage(`That Pokemon isn't in your party.`);
		}
		// Somebody has to be able to walk into the next battle.
		if (player.party.length <= 1) {
			throw new Chat.ErrorMessage(`You can't box your last Pokemon.`);
		}

		player.party.splice(found.index, 1);
		player.box.push(found.pokemon);

		this.save();
		this.update();
	}

	/** Box -> party. */
	withdraw(user: User, uid: string): void {
		const player = this.actingPlayer(user, `change your party`);
		const found = this.findPokemon(player, uid);
		if (!found || found.list !== player.box) {
			throw new Chat.ErrorMessage(`That Pokemon isn't in your box.`);
		}
		if (player.party.length >= this.campaign.manifest.maxPartySize) {
			throw new Chat.ErrorMessage(`Your party is full. Box someone first.`);
		}

		player.box.splice(found.index, 1);
		player.party.push(found.pokemon);

		this.save();
		this.update();
	}

	/**
	 * Moves a party member to the front.
	 *
	 * The lead is a real choice: teams are built from the party in order, so
	 * this decides who is sent out first in every battle from here on.
	 */
	makeLead(user: User, uid: string): void {
		const player = this.actingPlayer(user, `change your party`);
		const found = this.findPokemon(player, uid);
		if (!found || found.list !== player.party) {
			throw new Chat.ErrorMessage(`That Pokemon isn't in your party.`);
		}
		if (found.index === 0) return;

		player.party.splice(found.index, 1);
		player.party.unshift(found.pokemon);

		this.save();
		this.update();
	}

	/* -------------------------------------------------------------- *
	 * Answering a level-up
	 *
	 * Both of these are choices the owner has to make, so they sit in that
	 * player's panel until answered. They do not block anyone: a co-op run
	 * cannot stop five people while one decides what Torchic should forget.
	 * -------------------------------------------------------------- */

	/** Finds a queued decision, and the Pokemon it is about. */
	private takePending(
		player: AdventurePlayerState, kind: Pending['kind'], uid: string,
		matches: (entry: Pending) => boolean
	): { entry: Pending, pokemon: PartyPokemon } | null {
		player.pending ||= [];
		const index = player.pending.findIndex(
			entry => entry.kind === kind && entry.uid === uid && matches(entry)
		);
		if (index < 0) return null;

		const found = [...player.party, ...player.box].find(pokemon => pokemon.uid === uid);
		if (!found) {
			// The Pokemon is gone; the question goes with it.
			player.pending.splice(index, 1);
			return null;
		}
		return { entry: player.pending.splice(index, 1)[0], pokemon: found };
	}

	/**
	 * Answers a "learn this over what?" prompt.
	 *
	 * `slot` is which of the four to give up, or -1 to keep them all. Both are
	 * real answers - a starter's fourth move is often better than the fifth.
	 */
	learnMove(user: User, uid: string, move: string, slot: number): void {
		const player = this.actingPlayer(user, `learn a move`);
		const moveid = toID(move);

		const found = this.takePending(player, 'learn', uid, entry => (
			entry.kind === 'learn' && entry.move === moveid
		));
		if (!found) throw new Chat.ErrorMessage(`That decision has already been made.`);

		const name = Dex.mod(this.campaign.mod).moves.get(moveid).name;
		if (slot < 0) {
			this.room.add(
				Utils.html`|html|<div class="infobox"><small>${player.name}:</small> ` +
				Utils.html`${displayName(found.pokemon)} did not learn ${name}.</div>`
			);
		} else {
			const forgotten = found.pokemon.moves[slot];
			if (!forgetMove(this.campaign, found.pokemon, moveid, slot)) {
				throw new Chat.ErrorMessage(`That move slot doesn't exist.`);
			}
			const forgottenName = Dex.mod(this.campaign.mod).moves.get(forgotten).name;
			this.room.add(
				Utils.html`|html|<div class="infobox"><small>${player.name}:</small> ` +
				Utils.html`${displayName(found.pokemon)} forgot ${forgottenName} and learned ${name}!</div>`
			);
		}

		this.save();
		this.update();
	}

	/**
	 * Answers an evolution prompt.
	 *
	 * Declining is not permanent: the check runs again on the next level-up, so
	 * a Pokemon kept unevolved keeps asking, exactly as it does in the games.
	 */
	resolveEvolution(user: User, uid: string, into: string, accept: boolean): void {
		const player = this.actingPlayer(user, `evolve a Pokemon`);

		const found = this.takePending(player, 'evolve', uid, entry => (
			entry.kind === 'evolve' && toID(entry.into) === toID(into)
		));
		if (!found) throw new Chat.ErrorMessage(`That decision has already been made.`);

		if (!accept) {
			this.room.add(
				Utils.html`|html|<div class="infobox"><small>${player.name}:</small> ` +
				Utils.html`${displayName(found.pokemon)} stopped evolving.</div>`
			);
			this.save();
			this.update();
			return;
		}

		const was = displayName(found.pokemon);
		if (!evolve(this.campaign, found.pokemon, into)) {
			throw new Chat.ErrorMessage(`That evolution isn't possible.`);
		}

		this.room.add(
			Utils.html`|html|<div class="broadcast-green">${player.name}'s ${was} evolved into ` +
			Utils.html`${found.pokemon.species}!</div>`
		);

		// Nincada's other half: a Shedinja left behind, if there is a spare slot
		// and a spare ball to put it in.
		const extra = maybeShedinja(this.campaign, player, found.pokemon, (species, level) => createPokemon({
			campaign: this.campaign,
			species,
			level,
			prng: this.prng,
			trainer: player.token as ID,
			location: this.state.location,
		}));
		if (extra) {
			this.state.seed = this.prng.getSeed();
			this.room.add(
				Utils.html`|html|<div class="broadcast-green">A ${extra.species} was left behind in ` +
				Utils.html`${player.name}'s party!</div>`
			);
		}

		this.save();
		this.update();
	}

	/* -------------------------------------------------------------- *
	 * Shopping
	 * -------------------------------------------------------------- */

	/**
	 * Buys one of something from the mart here.
	 *
	 * Barred mid-encounter because the bag is copied into the battle when it
	 * starts and copied back when it ends, so anything bought in between would
	 * be silently overwritten by the simulator's count.
	 */
	buy(user: User, itemid: string): void {
		const player = this.actingPlayer(user, `go shopping`);

		const ball = this.campaign.stockAt(this.state.location).find(entry => entry.id === toID(itemid));
		if (!ball?.price) throw new Chat.ErrorMessage(`That isn't sold here.`);
		if (player.money < ball.price) {
			throw new Chat.ErrorMessage(`A ${ball.name} costs $${ball.price}; you have $${player.money}.`);
		}

		player.money -= ball.price;
		player.bag[ball.id] = (player.bag[ball.id] || 0) + 1;

		this.save();
		this.sendPanel(user);
	}

	/**
	 * Everyone is down: back to the last Pokemon Centre, healed, lighter of
	 * pocket. Emerald takes half your money; so do we.
	 */
	private whiteOut(): void {
		const destination = this.campaign.location(this.state.lastPokecenter) ?
			this.state.lastPokecenter :
			this.campaign.manifest.startLocation;

		for (const token of this.state.playerOrder) {
			const player = this.state.players[token];
			if (!player) continue;
			healParty(player, this.campaign.mod);
			player.money = Math.floor(player.money / 2);
		}

		this.state.cameFrom = '';
		this.state.location = destination;
		const here = this.campaign.location(destination);
		this.state.phase = ['town', 'city'].includes(here?.kind || '') ? 'overworld' : 'route';

		this.room.add(
			`|html|<div class="broadcast-red"><strong>Everyone whited out!</strong></div>`
		);
		this.room.add(
			Utils.html`|html|<div class="infobox">The party came to in ${here?.name || destination}, ` +
			`healed, and half their money gone.</div>`
		);

		this.save();
		this.openTravelVote();
	}

	healEveryone(): void {
		for (const token of this.state.playerOrder) {
			const player = this.state.players[token];
			if (player) healParty(player, this.campaign.mod);
		}
		this.state.phase = 'pokecenter';
		this.room.add(
			`|html|<div class="broadcast-green">Everyone's Pokemon were restored to full health.</div>`
		);
		this.save();
		this.openTravelVote();
	}

	travelTo(locationId: string): void {
		const destination = this.campaign.location(locationId);
		if (!destination) {
			Monitor.error(`Adventure ${this.roomid} tried to travel to unknown location "${locationId}"`);
			this.openTravelVote();
			return;
		}

		// Re-check on arrival: a vote can outlive the state it was opened against.
		const exit = this.campaign.exits(this.state.location).find(entry => entry.id === locationId);
		if (exit && !meetsAll(this.state.progress, exit.requires)) {
			this.room.add(
				Utils.html`|html|<div class="broadcast-red">The way to ${destination.name} is closed.</div>`
			).update();
			this.openTravelVote();
			return;
		}

		const firstVisit = !this.state.visited.includes(locationId);
		this.state.cameFrom = this.state.location;
		this.state.location = locationId;
		if (firstVisit) this.state.visited.push(locationId);
		// Anywhere with a Centre becomes the place a wipe sends you back to.
		if (destination.pokecenter) this.state.lastPokecenter = locationId;
		this.state.phase = ['town', 'city'].includes(destination.kind) ? 'overworld' : 'route';
		this.state.gauntletIndex = 0;

		this.room.add(
			Utils.html`|html|<div class="infobox">The party travels to <strong>${destination.name}</strong>.` +
			(firstVisit ? ` <small>(somewhere new)</small>` : ``) + `</div>`
		);

		this.save();
		this.openTravelVote();
	}

	end(user: User | null, reason = ''): void {
		if (this.ended) return;
		this.vote?.destroy();
		this.vote = null;
		this.state.phase = 'ended';

		const by = user ? Utils.html` by ${user.name}` : '';
		this.room.add(`|html|<div class="broadcast-red">The adventure was ended${by}.${reason}</div>`);
		this.room.add(`|allowleave|`).update();

		deleteAdventure(this.state.roomid);
		this.setEnded();
		this.destroy();
	}

	/* -------------------------------------------------------------- *
	 * Display
	 * -------------------------------------------------------------- */

	/**
	 * Pushes the board to everyone and controls to each viewer individually.
	 *
	 * These go out with `send`/`sendUser` rather than `add`, so repainting the
	 * UI hundreds of times over a long adventure doesn't bloat the room log.
	 * New arrivals get the current state from `onConnect` instead.
	 */
	update(): void {
		for (const userid in this.room.users) {
			this.sendPanel(this.room.users[userid]);
		}
		this.room.update();
	}

	/**
	 * Repaints one viewer's panel.
	 *
	 * The page is rendered per-viewer (the host gets a Start button, a
	 * spectator gets Join), so this pushes to that user's connections rather
	 * than broadcasting. Connections that don't have the page open are skipped
	 * - `openPages` is the client's own record of what it is showing.
	 */
	sendPanel(user: User): void {
		const playerState = this.playerStateFor(user);
		const html = panel(this.state, this.campaign, playerState, this.vote, this.viewerContext(playerState));
		for (const connection of user.connections) {
			if (connection.openPages?.has(this.pageid)) {
				connection.send(`>view-${this.pageid}\n|pagehtml|${html}`);
			}
		}
	}

	/** The panel as HTML, for the page handler to render on first open. */
	panelFor(user: User): string {
		// Opening the page is how most people come back to a run, so this is the
		// other place a returning player has to be reattached to their party.
		this.rebindReturningPlayer(user);
		const playerState = this.playerStateFor(user);
		return panel(this.state, this.campaign, playerState, this.vote, this.viewerContext(playerState));
	}

	/**
	 * The part of the panel that differs per viewer: which searches are open to
	 * them, and whether their party is currently frozen in a battle.
	 */
	private viewerContext(player: AdventurePlayerState | null): ViewerContext {
		if (!player) return { search: [], busy: false };
		return { search: this.searchOptions(player), busy: this.isBattling(player.token) };
	}

	/** Repaints just one player's panel, e.g. after they pick a starter. */
	updatePlayerView(player: AdventurePlayer): void {
		const user = player.getUser();
		if (user) this.sendPanel(user);
	}

	/** A way back to the panel for anyone who closed it. */
	sendOpenButton(user: User): void {
		this.room.sendUser(
			user,
			`|uhtml|adventure-open|<div class="infobox" style="text-align:center">` +
			`<button class="button notifying" name="joinRoom" value="view-${this.pageid}">` +
			`Open the adventure panel</button></div>`
		);
	}

	override onConnect(user: User, connection: Connection): void {
		// Before anything is drawn: if this is somebody coming back to a run
		// that outlived a restart, give them their party back.
		this.rebindReturningPlayer(user);

		// The panel *is* the game, so opening it is not something anyone should
		// have to go looking for. Going through `/join` rather than pushing the
		// HTML directly is what registers it in `openPages`, which is what makes
		// later repaints reach this connection.
		void Chat.parse(`/join view-${this.pageid}`, this.room, user, connection);
		// A way back for anyone who closes it.
		this.sendOpenButton(user);
	}

	/* -------------------------------------------------------------- *
	 * Housekeeping
	 * -------------------------------------------------------------- */

	save(): void {
		saveAdventure(this.state);
		this.pokeTimeout();
	}

	/** An abandoned lobby shouldn't live forever. Started adventures are left alone. */
	pokeTimeout(): void {
		if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
		this.timeoutTimer = null;
		if (this.state.phase !== 'lobby') return;

		this.timeoutTimer = setTimeout(() => {
			if (this.ended || this.state.phase !== 'lobby') return;
			this.room.add(`|html|<div class="broadcast-red">This adventure expired before it started.</div>`).update();
			this.end(null);
		}, LOBBY_TIMEOUT);
	}

	override destroy(): void {
		if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
		this.timeoutTimer = null;
		this.vote?.destroy();
		this.vote = null;
		const room = this.room;
		super.destroy();
		room?.destroy();
	}
}
