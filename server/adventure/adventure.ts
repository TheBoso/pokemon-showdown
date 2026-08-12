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
 * - The UI is rendered into `|fieldhtml|` and `|controlshtml|`, not into chat.
 *   The client gives a `game-*` room a battle panel with an empty control
 *   surface, so those two channels are ours. Nobody types a command; every
 *   command in the plugin exists to back a button.
 *
 * - Players are identified by an opaque token, not a userid. Userids are not
 *   stable - a guest who picks a name becomes a different user - and keying a
 *   party to one would orphan it mid-run. This is what lets guests play.
 */

import { Utils } from '../../lib';
import { PRNG } from '../../sim/prng';
import { RoomGame, RoomGamePlayer } from '../room-game';
import { getCampaign, type Campaign } from './campaigns';
import { allAdventures, deleteAdventure, saveAdventure } from './storage';
import { controls, field } from './render';
import {
	createAdventureState, createPlayerState, createPokemon,
	type AdventurePlayerState, type AdventureState,
} from './state';

/** How long an untouched lobby sticks around before it cleans itself up. */
const LOBBY_TIMEOUT = 60 * 60 * 1000;

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
	override room!: GameRoom;
	/**
	 * Renaming is safe: state is keyed by token, and `onRename` remaps the
	 * userid binding. A guest picking a name keeps their party.
	 */
	override allowRenames = true;

	state: AdventureState;
	campaign: Campaign;
	prng: PRNG;
	timeoutTimer: NodeJS.Timeout | null = null;

	constructor(room: GameRoom, state: AdventureState, campaign: Campaign) {
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

	static nextRoomid(): RoomID {
		let num = 1;
		while (Rooms.get(`game-adventure-${num}` as RoomID)) num++;
		return `game-adventure-${num}` as RoomID;
	}

	/** Creates a brand new adventure and drops the host into it. */
	static create(user: User, campaign: Campaign): Adventure {
		const roomid = Adventure.nextRoomid();
		const room = Rooms.createGameRoom(roomid, campaign.name, {
			// Not `isPersonal`: personal rooms deallocate when idle, and an
			// adventure is allowed to sit quiet without being destroyed.
			isPrivate: 'hidden',
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
			const room = Rooms.createGameRoom(state.roomid, campaign.name, { isPrivate: 'hidden' });
			const game = new Adventure(room, state, campaign);
			room.game = game;
			game.update();
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
		this.update();
	}

	end(user: User | null, reason = ''): void {
		if (this.ended) return;
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
		this.room.send(`|fieldhtml|${field(this.state, this.campaign)}`);
		for (const userid in this.room.users) {
			this.sendControls(this.room.users[userid]);
		}
		this.room.update();
	}

	/** Sends one viewer the control surface appropriate to them. */
	sendControls(user: User): void {
		const playerState = this.playerStateFor(user);
		this.room.sendUser(user, `|controlshtml|${controls(this.state, this.campaign, playerState)}`);
	}

	/** Repaints just one player's controls, e.g. after they pick a starter. */
	updatePlayerView(player: AdventurePlayer): void {
		const user = player.getUser();
		if (user) this.sendControls(user);
	}

	override onConnect(user: User): void {
		// Anyone arriving - player or spectator - needs the current board and
		// their own controls, since neither is replayed from the room log.
		this.room.sendUser(user, `|fieldhtml|${field(this.state, this.campaign)}`);
		this.sendControls(user);
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
		const room = this.room;
		super.destroy();
		room?.destroy();
	}
}
