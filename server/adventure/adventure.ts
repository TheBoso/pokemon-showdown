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
 * Milestone 1 covers the lobby: creating an adventure, joining it, picking a
 * starter, and starting. Movement, voting, battles and catching build on top
 * of the state layer this establishes.
 */

import { Utils } from '../../lib';
import { PRNG } from '../../sim/prng';
import { RoomGame, RoomGamePlayer } from '../room-game';
import { getCampaign, type Campaign } from './campaigns';
import { allAdventures, deleteAdventure, saveAdventure } from './storage';
import { adventureView, lobbyView, selfView, starterPicker } from './render';
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
 * `AdventurePlayerState` inside `AdventureState`, because that is what has to
 * survive a server restart. This class is just the binding between a `User`
 * and that state.
 */
export class AdventurePlayer extends RoomGamePlayer<Adventure> {
	get state(): AdventurePlayerState {
		return this.game.state.players[this.id];
	}
}

export class Adventure extends RoomGame<AdventurePlayer> {
	override readonly gameid = 'adventure' as ID;
	override room!: GameRoom;
	/** Renames would desync `state.players`, which is keyed by userid. */
	override allowRenames = false;

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
		for (const id of state.playerOrder) {
			const user = Users.getExact(id);
			if (user) super.addPlayer(user);
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
			// adventure is allowed to sit quiet for a while without being destroyed.
			isPrivate: 'hidden',
		});

		const state = createAdventureState(roomid, user, campaign);
		const game = new Adventure(room, state, campaign);
		room.game = game;

		game.addPlayer(user);
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
			room.add(`|html|<div class="broadcast-blue">This adventure was restored after a server restart.</div>`);
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
	 * Joining and leaving
	 * -------------------------------------------------------------- */

	override addPlayer(user: User): AdventurePlayer | null {
		const player = super.addPlayer(user);
		if (!player) return null;

		if (!this.state.players[user.id]) {
			this.state.players[user.id] = createPlayerState(user, this.campaign);
			this.state.playerOrder.push(user.id);
		}
		this.room.auth.set(user.id, Users.PLAYER_SYMBOL);
		return player;
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

		this.room.add(Utils.html`|c|~|${user.name} joined the adventure.`);
		this.save();
		this.update();
	}

	override leaveGame(user: User): void {
		const player = this.playerTable[user.id];
		if (!player) throw new Chat.ErrorMessage(`You are not in this adventure.`);
		if (this.state.phase !== 'lobby') {
			throw new Chat.ErrorMessage(
				`You can't leave an adventure once it has started - use /adventure end to stop it.`
			);
		}

		this.removePlayer(player);
		delete this.state.players[user.id];
		this.state.playerOrder = this.state.playerOrder.filter(id => id !== user.id);
		this.room.auth.set(user.id, '+');

		this.room.add(Utils.html`|c|~|${user.name} left the adventure.`);

		// The host leaving hands the adventure to whoever is next in line.
		if (this.state.host === user.id && this.state.playerOrder.length) {
			this.state.host = this.state.playerOrder[0];
			const newHost = this.state.players[this.state.host];
			this.room.add(Utils.html`|c|~|${newHost.name} is now the host.`);
		}

		this.save();
		this.update();
	}

	/* -------------------------------------------------------------- *
	 * Lobby
	 * -------------------------------------------------------------- */

	pickStarter(user: User, speciesid: string): void {
		const player = this.playerTable[user.id];
		if (!player) throw new Chat.ErrorMessage(`You are not in this adventure - use /adventure join first.`);
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
		if (playerState.party.length) {
			throw new Chat.ErrorMessage(`You have already chosen ${playerState.party[0].species}.`);
		}

		playerState.party.push(createPokemon({
			campaign: this.campaign,
			species: starter.species,
			level: this.campaign.manifest.starterLevel,
			prng: this.prng,
			trainer: user.id,
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
		if (this.state.host !== user.id) {
			throw new Chat.ErrorMessage(`Only the host can start the adventure.`);
		}
		if (this.state.phase !== 'lobby') {
			throw new Chat.ErrorMessage(`This adventure has already started.`);
		}

		const players = this.state.playerOrder.map(id => this.state.players[id]);
		if (!players.length) throw new Chat.ErrorMessage(`Nobody has joined the adventure yet.`);

		const waiting = players.filter(player => !player.party.length);
		if (waiting.length) {
			const names = waiting.map(player => player.name).join(', ');
			throw new Chat.ErrorMessage(`Still waiting on a starter from: ${names}.`);
		}

		this.state.phase = 'overworld';
		const start = this.campaign.location(this.state.location);
		const where = start?.name || this.state.location;

		this.room.add(`|html|<div class="broadcast-green"><strong>The adventure has begun!</strong></div>`);
		this.room.add(
			Utils.html`|html|<div class="infobox">You set out from ${where}. ` +
			`<small style="color:#666">Movement and voting arrive in the next milestone.</small></div>`
		);

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

	/** Re-renders the shared panel for everyone, plus each player's own panel. */
	update(): void {
		const shared = this.state.phase === 'lobby' ?
			lobbyView(this.state, this.campaign, false) :
			adventureView(this.state, this.campaign);
		this.room.add(`|uhtml|adventure|${shared}`);

		// The host's panel has controls nobody else gets, so it is re-sent to
		// them alone, replacing what they were shown a moment ago.
		if (this.state.phase === 'lobby') {
			const host = Users.getExact(this.state.host);
			if (host) {
				host.sendTo(this.room, `|uhtmlchange|adventure|${lobbyView(this.state, this.campaign, true)}`);
			}
		}

		this.room.update();

		for (const player of this.players) {
			this.updatePlayerView(player);
		}
	}

	/** The private panel: a player's own party, and their starter picker. */
	updatePlayerView(player: AdventurePlayer): void {
		const user = player.getUser();
		if (!user) return;
		const playerState = player.state;
		if (!playerState) return;

		if (this.state.phase === 'lobby' && !playerState.party.length) {
			player.sendRoom(`|uhtml|adventure-self|${starterPicker(this.state.roomid, this.campaign)}`);
			return;
		}

		player.sendRoom(`|uhtml|adventure-self|${selfView(this.campaign, playerState)}`);
	}

	override onConnect(user: User): void {
		const player = this.playerTable[user.id];
		if (player) {
			this.updatePlayerView(player);
		}
		// Re-send the shared panel so a reconnecting user isn't staring at a
		// blank room while waiting for the next update.
		const shared = this.state.phase === 'lobby' ?
			lobbyView(this.state, this.campaign, user.id === this.state.host) :
			adventureView(this.state, this.campaign);
		user.sendTo(this.room, `|uhtml|adventure|${shared}`);
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
