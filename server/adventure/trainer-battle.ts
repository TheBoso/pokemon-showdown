/**
 * Adventure - trainer battles
 *
 * A real Showdown battle in its own sub-room, parented to the adventure room,
 * with the trainer's slots driven by `trainer-ai.ts` instead of a human.
 *
 * The AI slot works because `RoomBattle` already tolerates a player with no
 * user: `addPlayer(null, null)` is how it fills unclaimed slots, and the
 * `sideupdate` handler is null-safe about sending to them. So the slot exists,
 * its `|request|` is stored like anyone else's, and nothing is delivered to a
 * client. We read that stored request and answer it ourselves.
 *
 * Two consequences worth knowing:
 *
 * - The battle must be created with `delayedStart`, because `RoomBattle#start`
 *   throws if a player has no `User`. We mark it started ourselves afterwards.
 * - The AI only ever sees its own `|request|`. Anything it knows about the
 *   other side is scraped from the battle log as it streams past.
 */

import { Utils } from '../../lib';
import { PRNG } from '../../sim/prng';
import { RoomBattle, type RoomBattleOptions } from '../room-battle';
import { chooseAction, type AIRequest, type FoeView } from './trainer-ai';
import { partyToTeam, splitTrainerTeam, trainerToTeam, type AdventureSet } from './teams';
import type { Campaign, TrainerData } from './campaigns';
import type { AdventurePlayerState } from './state';

export interface TrainerSlot {
	slot: SideID;
	name: string;
	team: AdventureSet[];
}

/** One Pokemon's condition as the simulator sees it, from `>requeststate`. */
export interface BattleSideState {
	name: string;
	species: string;
	hp: number;
	maxhp: number;
	fainted: boolean;
	status: string;
	statusTurns: number;
	pp: number[];
	moves: string[];
}

export interface TrainerBattleOptions {
	format: string;
	/** Slots controlled by a human, in order. */
	players: { user: User, team: AdventureSet[] }[];
	/** Slots the AI plays. */
	trainerSlots: TrainerSlot[];
	/** The adventure room this battle belongs to. */
	parent: Room;
	title: string;
	mod: string;
	/** Emerald AI script flags for this trainer. */
	flags?: string[];
	seed?: PRNGSeed;
}

/** `p1a: Torchic` -> 1. Side ids stay p1..p4 even in multi. */
function slotNumber(position: string): number {
	const match = /^p(\d)/.exec(position);
	return match ? Number(match[1]) : 0;
}

/** In multi, p1+p3 face p2+p4; in singles, p1 faces p2. */
function isFoeOf(a: number, b: number): boolean {
	return a > 0 && b > 0 && (a - 1) % 2 !== (b - 1) % 2;
}

export class TrainerBattle extends RoomBattle {
	aiSlots = new Map<SideID, TrainerSlot>();
	/** Position (`p1a`) -> what we can see of the Pokemon standing there. */
	seen = new Map<string, FoeView>();
	/** Last request id answered per AI slot, so we never answer one twice. */
	answered = new Map<SideID, number>();
	prng: PRNG;
	aiFlags: string[];
	mod: string;
	/** Side index (0-based) -> player token, for mapping results back. */
	playerSides = new Map<number, string>();

	constructor(room: GameRoom, options: RoomBattleOptions, trainer: TrainerBattleOptions) {
		super(room, options);
		this.mod = trainer.mod;
		this.aiFlags = trainer.flags || [];
		this.prng = new PRNG(trainer.seed);
		for (const entry of trainer.trainerSlots) this.aiSlots.set(entry.slot, entry);
	}

	/**
	 * Announces the AI's slots to the simulator.
	 *
	 * Called after construction rather than from it: the sim starts the battle
	 * the moment the last side is set, and starting before we are ready to
	 * answer requests would strand the first turn.
	 */
	seatTrainers(): void {
		for (const entry of this.aiSlots.values()) {
			void this.stream.write(`>player ${entry.slot} ` + JSON.stringify({
				name: entry.name,
				team: entry.team,
			}));
		}
	}

	/** Which slots this one is fighting. */
	private foesOf(slot: SideID): FoeView[] {
		const me = slotNumber(slot);
		const foes: FoeView[] = [];
		for (const [position, view] of this.seen) {
			if (isFoeOf(me, slotNumber(position))) foes.push(view);
		}
		return foes;
	}

	/**
	 * Scrapes the public battle log for who is on the field and how hurt they
	 * are. This is the AI's only window onto the other side.
	 */
	private observe(lines: string[]): void {
		for (const line of lines) {
			const parts = line.split('|');
			const [, command, ...rest] = parts;

			if (command === 'switch' || command === 'drag' || command === 'replace') {
				const position = rest[0]?.split(':')[0];
				const species = rest[1]?.split(',')[0]?.trim();
				if (position && species) this.seen.set(position, { species, hpFraction: 1 });
				continue;
			}

			if (command === '-damage' || command === '-heal' || command === '-sethp') {
				const position = rest[0]?.split(':')[0];
				const view = position && this.seen.get(position);
				if (!view) continue;
				const condition = rest[1] || '';
				if (condition.startsWith('0 ') || condition.endsWith(' fnt')) {
					view.hpFraction = 0;
				} else {
					// Either "34/100" (percentage mod) or "12/39".
					const [current, max] = condition.split(' ')[0].split('/').map(Number);
					if (max > 0) view.hpFraction = Math.max(0, current / max);
				}
				continue;
			}

			if (command === 'faint') {
				const position = rest[0]?.split(':')[0];
				const view = position && this.seen.get(position);
				if (view) view.hpFraction = 0;
			}
		}
	}

	/**
	 * Live HP, status and PP for every side, straight from the simulator.
	 *
	 * The battle runs in a child process, so this is a round trip: push a
	 * resolver, write the request, and `receive` hands the answer back when
	 * `requesteddata` arrives.
	 *
	 * Safe to call after the battle has ended: `RoomBattleStream` is keepAlive,
	 * so the simulator stays answerable rather than closing on its `end`.
	 */
	requestState(): Promise<BattleSideState[][]> {
		this.dataResolvers ||= [];
		const answer = new Promise<string[]>((resolve, reject) => {
			this.dataResolvers!.push([resolve, reject]);
		});
		void this.stream.write(`>requeststate`);
		return answer.then(lines => {
			try {
				return JSON.parse(lines.join('\n')) as BattleSideState[][];
			} catch {
				return [];
			}
		});
	}

	override receive(lines: string[]): void {
		if (lines[0] === 'update') this.observe(lines.slice(1));

		super.receive(lines);

		// `super.receive` has stored the request by now; answer it if it is ours.
		if (lines[0] === 'sideupdate') this.act(lines[1] as SideID);
	}

	/** Answers one AI slot's outstanding request, if it has one. */
	private act(slot: SideID): void {
		const entry = this.aiSlots.get(slot);
		if (!entry || this.ended) return;

		const player = this[slot];
		const stored = player?.request;
		if (!stored?.request) return;
		// Requests repeat as the battle re-sends state; only act on new ones.
		if (this.answered.get(slot) === stored.rqid) return;

		let request: AIRequest;
		try {
			request = JSON.parse(stored.request);
		} catch {
			return;
		}
		if (request.wait) return;

		const choice = chooseAction(request, {
			mod: this.mod,
			foeActive: this.foesOf(slot),
			flags: this.aiFlags,
			pick: items => this.prng.sample(items),
		});
		if (!choice) return;

		this.answered.set(slot, stored.rqid);
		// Mark it answered on the player too, so the inactivity timer does not
		// treat an AI slot as a player who has gone quiet.
		stored.isWait = true;
		stored.choice = choice;
		void this.stream.write(`>${slot} ${choice}`);
	}
}

/**
 * Builds and starts a trainer battle in its own room.
 *
 * With one human it is a straight singles match; with two it is a multi battle
 * where the pair share a side against the trainer's two slots. Two is the
 * ceiling because Showdown allows no more.
 */
export function createTrainerBattle(options: {
	parent: Room,
	campaign: Campaign,
	trainer: TrainerData,
	players: { player: AdventurePlayerState, user: User }[],
	seed?: PRNGSeed,
}): GameRoom | null {
	const { campaign, trainer, parent } = options;
	const mod = campaign.mod;
	const humans = options.players.slice(0, MAX_SIDE);
	if (!humans.length) return null;

	const isMulti = humans.length > 1;
	const format = isMulti ? campaign.manifest.multiBattleFormat : campaign.manifest.battleFormat;

	const trainerTeam = trainerToTeam(trainer, mod);
	if (!trainerTeam.length) return null;

	// Slot layout: humans take p1 (and p3 in multi), the trainer p2 (and p4).
	const trainerSlots: TrainerSlot[] = [];
	if (isMulti) {
		const [first, second] = splitTrainerTeam(trainerTeam);
		trainerSlots.push({ slot: 'p2', name: trainer.name, team: first });
		// A one-Pokemon trainer leaves p4 empty rather than duplicating them.
		if (second.length) trainerSlots.push({ slot: 'p4', name: trainer.name, team: second });
	} else {
		trainerSlots.push({ slot: 'p2', name: trainer.name, team: trainerTeam });
	}

	// `players` is positional: index 0 is p1, 1 is p2, and so on. Holes become
	// userless slots, which is exactly what the trainer needs.
	const players: any[] = [];
	players[0] = { user: humans[0].user, team: partyToTeam(humans[0].player, mod) };
	if (isMulti) players[2] = { user: humans[1].user, team: partyToTeam(humans[1].player, mod) };

	// Side indexes are 0-based: p1 is 0, p3 is 2.
	const playerSides = new Map<number, string>([[0, humans[0].player.token]]);
	if (isMulti) playerSides.set(2, humans[1].player.token);

	const title = `${trainer.trainerClass} ${trainer.name}`;
	const roomid = Rooms.global.prepBattleRoom(format);

	const battleOptions: RoomBattleOptions = {
		format,
		players,
		rated: false,
		allowRenames: false,
		// Required: RoomBattle#start throws on a player with no User, and the
		// trainer's slots have none. We mark it started below instead.
		delayedStart: true,
	};

	let room: GameRoom;
	try {
		room = Rooms.createGameRoom(roomid, title, { isPrivate: 'hidden' });
	} catch (err: any) {
		Monitor.crashlog(err, 'Adventure trainer battle room', { roomid });
		return null;
	}

	const battle = new TrainerBattle(room, battleOptions, {
		format,
		players: [],
		trainerSlots,
		parent,
		title,
		mod,
		flags: trainer.ai,
		seed: options.seed,
	});
	battle.playerSides = playerSides;
	room.game = battle;
	room.battle = battle;
	room.setParent(parent);

	// Sides are complete once the trainer is seated, and the sim starts the
	// moment the last one lands - so this happens after we can answer requests.
	battle.seatTrainers();
	battle.started = true;

	// `RoomBattle#start` names the room before the trainer has a name, so it
	// comes out as "vs. Player 2". Correct it now that the slots are filled.
	room.title = `${humans.map(entry => entry.player.name).join(' & ')} vs. ${trainer.name}`;
	room.send(`|title|${room.title}`);

	room.add(
		Utils.html`|html|<div class="infobox">Part of <a href="/${parent.roomid}">an adventure</a>.</div>`
	).update();

	for (const { user } of humans) user.joinRoom(room);
	return room;
}

/** Showdown allows at most two players a side. */
const MAX_SIDE = 2;
