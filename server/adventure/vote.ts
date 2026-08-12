/**
 * Adventure - timed votes
 *
 * The group decides where to go next by voting. This owns the mechanics of
 * one vote - options, tally, countdown, tie-break - and knows nothing about
 * maps or players beyond an opaque voter token.
 *
 * Deliberately not part of `AdventureState`: a vote is transient. If the
 * server restarts mid-vote the adventure reopens one on the next repaint,
 * which is a better outcome than persisting a countdown that expired while
 * the process was down.
 */

export interface VoteOption {
	id: string;
	label: string;
	/** Secondary line under the label. */
	detail?: string;
	/** If set, why this option cannot be chosen. Locked options still show. */
	locked?: string;
}

export interface VoteResult {
	winner: VoteOption;
	/** Vote counts by option id, including zeroes. */
	counts: { [optionId: string]: number };
	/** True when more than one option tied and the winner was drawn. */
	tied: boolean;
}

export class Vote {
	readonly title: string;
	readonly options: VoteOption[];
	readonly endsAt: number;
	/** voter token -> option id */
	private readonly ballots = new Map<string, string>();
	private timer: NodeJS.Timeout | null = null;
	private ended = false;

	constructor(
		options: {
			title: string,
			options: VoteOption[],
			durationMs: number,
			/** Repaint hook, called on a slow tick so the countdown stays honest. */
			onTick: () => void,
			onResolve: (result: VoteResult) => void,
			/** Tie-break, so a run stays reproducible from its seed. */
			pick: <T>(items: T[]) => T,
		}
	) {
		this.title = options.title;
		this.options = options.options;
		this.endsAt = Date.now() + options.durationMs;
		this.onTick = options.onTick;
		this.onResolve = options.onResolve;
		this.pick = options.pick;

		this.timer = setInterval(() => this.poke(), TICK_MS);
	}

	private readonly onTick: () => void;
	private readonly onResolve: (result: VoteResult) => void;
	private readonly pick: <T>(items: T[]) => T;

	/** Options a player is actually allowed to pick. */
	get choosable(): VoteOption[] {
		return this.options.filter(option => !option.locked);
	}

	secondsLeft(): number {
		return Math.max(0, Math.ceil((this.endsAt - Date.now()) / 1000));
	}

	votedFor(token: string): string | undefined {
		return this.ballots.get(token);
	}

	counts(): { [optionId: string]: number } {
		const counts: { [optionId: string]: number } = {};
		for (const option of this.options) counts[option.id] = 0;
		for (const optionId of this.ballots.values()) {
			if (optionId in counts) counts[optionId]++;
		}
		return counts;
	}

	/**
	 * Records a vote. Returns false if the option is unknown or locked.
	 *
	 * Changing your mind is allowed - the last ballot stands - which keeps the
	 * pressure off and lets the group talk it over while the clock runs.
	 */
	cast(token: string, optionId: string): boolean {
		if (this.ended) return false;
		const option = this.options.find(entry => entry.id === optionId);
		if (!option || option.locked) return false;
		this.ballots.set(token, optionId);
		return true;
	}

	/** Drops a voter, e.g. someone leaving mid-vote. */
	withdraw(token: string): void {
		this.ballots.delete(token);
	}

	/**
	 * Ends the vote early once every eligible voter has had their say, so a
	 * decided group is not left staring at a countdown.
	 */
	maybeResolveEarly(eligibleVoters: number): void {
		if (this.ended) return;
		if (eligibleVoters > 0 && this.ballots.size >= eligibleVoters) this.resolve();
	}

	private poke(): void {
		if (this.ended) return;
		if (Date.now() >= this.endsAt) {
			this.resolve();
		} else {
			this.onTick();
		}
	}

	/** Tallies and fires `onResolve`. Safe to call more than once. */
	resolve(): void {
		if (this.ended) return;
		this.ended = true;
		this.stop();

		const counts = this.counts();
		const choosable = this.choosable;
		// Nobody voted: every option is equally popular, so draw from all of them.
		const best = Math.max(...choosable.map(option => counts[option.id]));
		const leaders = choosable.filter(option => counts[option.id] === best);
		const winner = leaders.length === 1 ? leaders[0] : this.pick(leaders);

		this.onResolve({ winner, counts, tied: leaders.length > 1 });
	}

	get isEnded(): boolean {
		return this.ended;
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	destroy(): void {
		this.ended = true;
		this.stop();
	}
}

/** How often the countdown repaints. Slow: this is a chat UI, not a game loop. */
const TICK_MS = 10 * 1000;
