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
import { emptySlotTeam, partyToTeam, splitTrainerTeam, trainerToTeam, type AdventureSet } from './teams';
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

/** Everything `>requeststate` hands back. */
export interface BattleStateReport {
	sides: BattleSideState[][];
	/** Set by a ball move when a wild Pokemon is caught. */
	caught: { species: string, level: number, hp?: number } | null;
	/** The thrower's remaining balls, as itemid -> count. */
	balls: { [itemid: string]: number } | null;
}

const EMPTY_REPORT: BattleStateReport = { sides: [], caught: null, balls: null };

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

/**
 * One Pokemon of the opposing side going down, and who was in front of it
 * when it did.
 *
 * Gen 3 splits EXP between *participants* - everyone who was sent out against
 * that Pokemon - not across the whole party, so who was standing there has to
 * be recorded as it happens. Participants are `sideIndex:teamIndex`, which is
 * the same coordinate `absorbBattleState` uses to map results back.
 */
export interface ExpEvent {
	species: string;
	level: number;
	participants: string[];
}

/** `p1a: Torchic` -> 1. Side ids stay p1..p4 even in multi. */
function slotNumber(position: string): number {
	const match = /^p(\d)/.exec(position);
	return match ? Number(match[1]) : 0;
}

/** `|switch|p2a: Bob|Poochyena, L3, M|17/17` -> the level in the details field. */
function levelFromDetails(details: string): number {
	// Showdown leaves the level out entirely at 100.
	const match = /\bL(\d+)\b/.exec(details || '');
	return match ? Number(match[1]) : 100;
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

	/**
	 * EXP earned, in the order it was earned.
	 *
	 * Collected here rather than worked out afterwards because "who fought it"
	 * is only knowable while it is happening - by the end of the battle the
	 * field has been cleared and nothing in the final state says who faced what.
	 */
	expEvents: ExpEvent[] = [];
	/** Human side index -> team index of whoever it currently has out. */
	private activeIndex = new Map<number, number>();
	/** Foe position -> the participant keys that have faced what stands there. */
	private facing = new Map<string, Set<string>>();
	/** Foe position -> what stands there, so a faint knows what it was worth. */
	private foeOnField = new Map<string, { species: string, level: number }>();

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

	/** True for a slot the trainer (or the wild Pokemon) is playing. */
	private isFoePosition(position: string): boolean {
		return this.aiSlots.has(position.slice(0, 2) as SideID);
	}

	/** Everyone currently on the field on a human side, as participant keys. */
	private currentParticipants(): string[] {
		return [...this.activeIndex].map(([sideIndex, teamIndex]) => `${sideIndex}:${teamIndex}`);
	}

	/**
	 * Records which of a player's party is out, straight from their `|request|`.
	 *
	 * The request's `side.pokemon` is in team order and flags the active one,
	 * which is the only place the team *index* is stated outright - the public
	 * log gives nicknames, and two unnamed Zigzagoon are indistinguishable there.
	 */
	private noteActive(slot: SideID): void {
		const sideIndex = slotNumber(slot) - 1;
		if (!this.playerSides.has(sideIndex)) return;

		const stored = this[slot]?.request;
		if (!stored?.request) return;

		let parsed: AnyObject;
		try {
			parsed = JSON.parse(stored.request);
		} catch {
			return;
		}

		const team: AnyObject[] = parsed.side?.pokemon || [];
		const index = team.findIndex(entry => entry.active);
		if (index < 0) return;
		this.activeIndex.set(sideIndex, index);

		// Anyone on the field is facing whatever is standing opposite, so a
		// switch-in earns a share of the next thing that goes down.
		const key = `${sideIndex}:${index}`;
		for (const [position, seen] of this.facing) {
			if (this.foeOnField.has(position)) seen.add(key);
		}
	}

	/**
	 * Scrapes the public battle log for who is on the field and how hurt they
	 * are. This is the AI's only window onto the other side - and, for a foe
	 * slot, where its worth in EXP is read off and its faint is banked.
	 */
	private observe(lines: string[]): void {
		for (const line of lines) {
			const parts = line.split('|');
			const [, command, ...rest] = parts;

			if (command === 'switch' || command === 'drag' || command === 'replace') {
				const position = rest[0]?.split(':')[0];
				const species = rest[1]?.split(',')[0]?.trim();
				if (position && species) this.seen.set(position, { species, hpFraction: 1 });

				if (position && species && this.isFoePosition(position)) {
					// A fresh foe: its own EXP, and its own list of who fought it.
					this.foeOnField.set(position, { species, level: levelFromDetails(rest[1]) });
					this.facing.set(position, new Set(this.currentParticipants()));
				}
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
				if (!position) continue;

				if (this.isFoePosition(position)) {
					this.bankExp(position);
				} else {
					// A Pokemon that faints stops earning: gen 3 pays participants
					// still standing when the foe goes down, not everyone who ever
					// traded a hit with it.
					const sideIndex = slotNumber(position) - 1;
					const teamIndex = this.activeIndex.get(sideIndex);
					if (teamIndex === undefined) continue;
					for (const seen of this.facing.values()) seen.delete(`${sideIndex}:${teamIndex}`);
				}
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
	requestState(): Promise<BattleStateReport> {
		this.dataResolvers ||= [];
		const answer = new Promise<string[]>((resolve, reject) => {
			this.dataResolvers!.push([resolve, reject]);
		});
		void this.stream.write(`>requeststate`);
		return answer.then(lines => {
			try {
				const report = JSON.parse(lines.join('\n')) as BattleStateReport;
				return report?.sides ? report : EMPTY_REPORT;
			} catch {
				return EMPTY_REPORT;
			}
		});
	}

	/**
	 * A foe went down: record what it was worth and who was in front of it.
	 *
	 * A Pokemon caught rather than beaten is fainted off the field by the ball
	 * move, so it lands here too. Catching pays no EXP in the games, but that
	 * is the caller's call to make - it learns about the catch from the final
	 * report, and reading it out of the log here would mean matching on the
	 * text of a flavour message.
	 */
	private bankExp(position: string): void {
		const foe = this.foeOnField.get(position);
		this.foeOnField.delete(position);
		const participants = this.facing.get(position);
		this.facing.delete(position);

		if (!foe) return;
		this.expEvents.push({
			species: foe.species,
			level: foe.level,
			participants: [...participants || []],
		});
	}

	override receive(lines: string[]): void {
		if (lines[0] === 'update') this.observe(lines.slice(1));

		super.receive(lines);

		// `super.receive` has stored the request by now; answer it if it is ours,
		// and note who is on the field if it is a player's.
		if (lines[0] === 'sideupdate') {
			this.act(lines[1] as SideID);
			this.noteActive(lines[1] as SideID);
		}
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
 * One human is a straight singles match against the first trainer. Two is a
 * multi battle - Showdown's only game type where two people share a side -
 * with the pair on p1 and p3 against `trainers` on p2 and p4.
 *
 * **A multi battle cannot start until all four slots are seated.** The
 * simulator waits for `>player p4` and simply never begins without it, with no
 * error and no timeout. So p4 is filled three ways, in order of preference:
 * a second trainer, the lone trainer's own second Pokemon, or - for a single
 * trainer carrying a single Pokemon - an already-fainted stand-in, leaving
 * them to fight both players alone. Two against one is still a double battle;
 * the format is the shape of the field, not the number of opponents.
 */
export function createTrainerBattle(options: {
	parent: Room,
	campaign: Campaign,
	trainers: TrainerData[],
	players: { player: AdventurePlayerState, user: User }[],
	seed?: PRNGSeed,
}): GameRoom | null {
	const { campaign, parent } = options;
	const mod = campaign.mod;
	const humans = options.players.slice(0, MAX_SIDE);
	const trainers = options.trainers.slice(0, MAX_SIDE);
	if (!humans.length || !trainers.length) return null;

	const isMulti = humans.length > 1;
	const format = isMulti ? campaign.manifest.multiBattleFormat : campaign.manifest.battleFormat;

	const trainerTeam = trainerToTeam(trainers[0], mod);
	if (!trainerTeam.length) return null;

	// Slot layout: humans take p1 (and p3 in multi), the trainers p2 (and p4).
	const trainerSlots: TrainerSlot[] = [];
	if (isMulti && trainers.length > 1) {
		// Two trainers, a slot and a full roster each.
		const partnerTeam = trainerToTeam(trainers[1], mod);
		if (!partnerTeam.length) return null;
		trainerSlots.push({ slot: 'p2', name: trainers[0].name, team: trainerTeam });
		trainerSlots.push({ slot: 'p4', name: trainers[1].name, team: partnerTeam });
	} else if (isMulti) {
		// One trainer holding both slots, their party dealt out alternately so
		// their lead stays in front.
		const [first, second] = splitTrainerTeam(trainerTeam);
		trainerSlots.push({ slot: 'p2', name: trainers[0].name, team: first });
		trainerSlots.push({
			slot: 'p4',
			name: trainers[0].name,
			team: second.length ? second : emptySlotTeam(trainers[0], mod),
		});
	} else {
		trainerSlots.push({ slot: 'p2', name: trainers[0].name, team: trainerTeam });
	}

	// `players` is positional: index 0 is p1, 1 is p2, and so on. Holes become
	// userless slots, which is exactly what the trainer needs.
	const players: any[] = [];
	players[0] = { user: humans[0].user, team: partyToTeam(humans[0].player, mod) };
	if (isMulti) players[2] = { user: humans[1].user, team: partyToTeam(humans[1].player, mod) };

	// Side indexes are 0-based: p1 is 0, p3 is 2.
	const playerSides = new Map<number, string>([[0, humans[0].player.token]]);
	if (isMulti) playerSides.set(2, humans[1].player.token);

	const title = trainers.map(entry => `${entry.trainerClass} ${entry.name}`).join(' & ');
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
		// One AI personality drives both slots. Pairing is our arrangement
		// rather than Emerald's, so there is no second script to honour.
		flags: trainers[0].ai,
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
	room.title = `${humans.map(entry => entry.player.name).join(' & ')} vs. ` +
		`${trainers.map(entry => entry.name).join(' & ')}`;
	room.send(`|title|${room.title}`);

	room.add(
		Utils.html`|html|<div class="infobox">Part of <a href="/${parent.roomid}">an adventure</a>.</div>`
	).update();

	for (const { user } of humans) user.joinRoom(room);
	return room;
}

/** Showdown allows at most two players a side. */
const MAX_SIDE = 2;
