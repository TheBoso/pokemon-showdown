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
import { panel } from './render';
import { describeAll, meetsAll, unmet } from './progress';
import { createTrainerBattle } from './trainer-battle';
import { Vote, type VoteOption, type VoteResult } from './vote';
import {
	createAdventureState, createPlayerState, createPokemon, healParty, isEveryoneWiped,
	type AdventurePlayerState, type AdventureState,
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
	/** Who that battle is against, so its result can be recorded. */
	battleTrainerId: string | null = null;
	/** Tokens of whoever is fighting it, so a loss can be applied to them. */
	battlePlayers: string[] = [];

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
			options.push({
				id: `${FIGHT_PREFIX}${next.id}`,
				label: `Battle ${next.trainer.trainerClass} ${next.trainer.name}`,
				detail: remaining.length > 1 ? `${remaining.length} trainers left here` : `last one here`,
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

		const online = battlers
			.map(player => ({ player, user: Users.getExact(player.userid) }))
			.filter((pair): pair is { player: AdventurePlayerState, user: User } => !!pair.user);
		if (!online.length) {
			this.room.add(
				`|html|<div class="broadcast-red">The chosen battlers are offline; try again.</div>`
			).update();
			this.openTravelVote();
			return;
		}

		const battle = createTrainerBattle({
			parent: this.room,
			campaign: this.campaign,
			trainer: entry.trainer,
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
		this.battleTrainerId = entry.id;
		this.battlePlayers = online.map(pair => pair.player.token);
		for (const { player } of online) {
			player.battlesFought++;
			player.lastBattleAt = Date.now();
		}

		const names = online.map(pair => pair.player.name).join(' and ');
		this.room.add(
			Utils.html`|html|<div class="infobox"><strong>${names}</strong> take on ` +
			Utils.html`${entry.trainer.trainerClass} ${entry.trainer.name}! ` +
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
		if (this.ended || room.roomid !== this.battleRoomid) return;
		this.battleRoomid = null;

		const trainerId = this.battleTrainerId;
		const battlers = this.battlePlayers;
		this.battleTrainerId = null;
		this.battlePlayers = [];
		const won = !!winnerid && !!this.state.playerTokens[winnerid];

		if (won && trainerId && !this.state.defeatedTrainers.includes(trainerId)) {
			this.state.defeatedTrainers.push(trainerId);
			const trainer = this.campaign.trainer(trainerId);
			this.room.add(
				Utils.html`|html|<div class="broadcast-green">${trainer?.name || 'The trainer'} was defeated!</div>`
			);
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
		const html = panel(this.state, this.campaign, playerState, this.vote);
		for (const connection of user.connections) {
			if (connection.openPages?.has(this.pageid)) {
				connection.send(`>view-${this.pageid}\n|pagehtml|${html}`);
			}
		}
	}

	/** The panel as HTML, for the page handler to render on first open. */
	panelFor(user: User): string {
		return panel(this.state, this.campaign, this.playerStateFor(user), this.vote);
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
