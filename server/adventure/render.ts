/**
 * Adventure - rendering
 *
 * All player-facing HTML lives here, so the game logic never has to think
 * about markup and the markup never has to think about game logic.
 *
 * The adventure room is a GameRoom, which the client routes to its battle
 * panel (`panel-battle.tsx` routes `game-*`). That panel builds a Battle
 * object for the room whether or not a battle is running, which means the two
 * battle display channels are ours to use:
 *
 *   |fieldhtml|     replaces the battle field - the shared board everyone sees
 *   |controlshtml|  replaces the entire controls pane - our buttons
 *
 * Because there is no battle request, the client renders no move or switch
 * buttons; the control surface is empty until we fill it. So the game UI is
 * entirely ours with no client changes. `room-battle-bestof.ts` uses the same
 * two channels.
 *
 * Controls are per-viewer (the host sees a Start button, a spectator sees
 * Join), so they are sent with `room.sendUser` rather than `room.add`.
 */

import { Utils } from '../../lib';
import type { Campaign } from './campaigns';
import { describeRequirement } from './progress';
import { expToNextLevel, levelProgress } from './progression';
import type { SearchOption } from './encounters';
import type { Vote } from './vote';
import {
	displayName, isFainted,
	type AdventurePlayerState, type AdventureState, type PartyPokemon,
} from './state';

/**
 * What one viewer can do right now, over and above the shared state.
 *
 * Searching, shopping and shuffling the party are personal - two people looking
 * at the same adventure see different buttons - so this is passed alongside the
 * state rather than derived from it.
 */
export interface ViewerContext {
	/** The wild-search buttons this viewer should see, and why any are shut. */
	search: SearchOption[];
	/**
	 * True while this viewer's party is committed to a live battle.
	 *
	 * A team is handed to the simulator once, at the start, and the result is
	 * matched back onto the party by position. Reordering it mid-battle would
	 * write the wrong Pokemon's HP onto the wrong Pokemon, so everything that
	 * touches the party or the bag is frozen until the battle ends.
	 */
	busy: boolean;
}

/** For spectators and for the lobby, where none of this applies. */
export const NO_ACTIONS: ViewerContext = { search: [], busy: false };

/** Wraps a command so a button sends it to the adventure room from anywhere. */
export function cmd(roomid: RoomID, command: string): string {
	return `/msgroom ${roomid},${command}`;
}

function button(roomid: RoomID, command: string, label: string, options: {
	disabled?: boolean, notifying?: boolean,
} = {}): string {
	const classes = `button${options.notifying ? ' notifying' : ''}`;
	if (options.disabled) {
		return `<button class="${classes}" disabled>${label}</button>`;
	}
	return `<button class="${classes}" name="send" value="${cmd(roomid, command)}">${label}</button>`;
}

/* ------------------------------------------------------------------ *
 * Pokemon
 * ------------------------------------------------------------------ */

function hpColor(fraction: number): string {
	if (fraction > 0.5) return '#7ac96a';
	if (fraction > 0.2) return '#e5c14e';
	return '#e05b4c';
}

export function hpBar(pokemon: PartyPokemon): string {
	const fraction = pokemon.maxhp ? Math.max(0, pokemon.hp / pokemon.maxhp) : 0;
	const percent = Math.round(fraction * 100);
	return (
		`<span style="display:inline-block;width:60px;height:6px;border:1px solid #666;` +
		`background:#eee;vertical-align:middle">` +
		`<span style="display:block;height:100%;width:${percent}%;background:${hpColor(fraction)}"></span>` +
		`</span>`
	);
}

export function statusTag(pokemon: PartyPokemon): string {
	if (isFainted(pokemon)) return ` <small style="color:#888">FNT</small>`;
	if (!pokemon.status) return '';
	return ` <small style="text-transform:uppercase">${pokemon.status}</small>`;
}

export function pokemonRow(pokemon: PartyPokemon): string {
	const faintedStyle = isFainted(pokemon) ? ' style="opacity:0.45"' : '';
	const shiny = pokemon.shiny ? ` <small style="color:#c9a227">&#9733;</small>` : '';
	return (
		`<span${faintedStyle}>` +
		`<psicon pokemon="${Utils.escapeHTML(pokemon.species)}" />` +
		Utils.html` <strong>${displayName(pokemon)}</strong>` + shiny +
		` <small>Lv${pokemon.level}</small> ` +
		hpBar(pokemon) +
		` <small>${pokemon.hp}/${pokemon.maxhp}</small>` +
		statusTag(pokemon) +
		`</span>`
	);
}

/**
 * How far through its level a Pokemon is.
 *
 * Thinner and cooler than the HP bar on purpose - it sits directly underneath
 * one, and two bars of equal weight read as two health bars at a glance.
 * Shown only on your own party; the shared board would be a wall of them.
 */
function expBar(campaign: Campaign, pokemon: PartyPokemon): string {
	const percent = Math.round(levelProgress(campaign, pokemon) * 100);
	const owed = expToNextLevel(campaign, pokemon);
	return (
		`<span style="display:inline-block;width:60px;height:3px;border:1px solid #99a;` +
		`background:#eee;vertical-align:middle">` +
		`<span style="display:block;height:100%;width:${percent}%;background:#6a8fd0"></span>` +
		`</span>` +
		(owed ? ` <small style="color:#999">${owed} EXP to Lv${pokemon.level + 1}</small>` : ``)
	);
}

export function partyView(player: AdventurePlayerState): string {
	if (!player.party.length) return `<em style="color:#888">No Pokemon yet.</em>`;
	return player.party.map(pokemon => `<div style="margin:2px 0">${pokemonRow(pokemon)}</div>`).join('');
}

/* ------------------------------------------------------------------ *
 * The field: the shared board, identical for everyone
 * ------------------------------------------------------------------ */

function locationName(campaign: Campaign, id: string): string {
	return campaign.location(id)?.name || id;
}

/**
 * `subtitleHTML` is already-safe HTML, not raw text - callers escape their own
 * dynamic parts. Passing it through `Utils.html` here would double-escape any
 * entity in it, which is exactly how `&middot;` ended up rendering literally.
 */
function header(campaign: Campaign, subtitleHTML: string): string {
	return (
		Utils.html`<h2 style="margin:4px 0">${campaign.name}</h2>` +
		`<div style="color:#666;font-size:9pt;margin-bottom:8px">${subtitleHTML}</div>`
	);
}

const DOT = ' &middot; ';

/** The lobby board: who has joined, and what they picked. */
export function lobbyField(state: AdventureState, campaign: Campaign): string {
	const players = state.playerOrder.map(token => state.players[token]).filter(Boolean);

	let buf = `<div style="padding:8px;text-align:center">`;
	buf += header(campaign, Utils.escapeHTML(campaign.manifest.region) + DOT + `waiting to start`);

	if (!players.length) {
		buf += `<p style="color:#888"><em>Nobody has joined yet.</em></p>`;
	} else {
		buf += `<table style="margin:0 auto;text-align:left">`;
		for (const player of players) {
			const starter = player.party[0];
			const ready = starter ?
				`<psicon pokemon="${Utils.escapeHTML(starter.species)}" /> ` +
				Utils.escapeHTML(starter.species) :
				`<small style="color:#888">choosing...</small>`;
			const hostTag = player.token === state.host ? ` <small style="color:#888">(host)</small>` : '';
			buf += Utils.html`<tr><td style="padding:2px 8px"><strong>${player.name}</strong>` + hostTag + `</td>`;
			buf += `<td style="padding:2px 8px">${ready}</td></tr>`;
		}
		buf += `</table>`;
	}

	const ready = players.filter(player => player.party.length).length;
	if (players.length && ready < players.length) {
		buf += `<p style="color:#888;font-size:9pt">` +
			`Waiting on ${players.length - ready} player(s) to choose a starter.</p>`;
	}

	buf += `</div>`;
	return buf;
}

/** The in-progress board: where everyone is, and how their parties look. */
export function adventureField(state: AdventureState, campaign: Campaign): string {
	const players = state.playerOrder.map(token => state.players[token]).filter(Boolean);

	let buf = `<div style="padding:8px">`;
	buf += `<div style="text-align:center">`;
	buf += header(campaign, Utils.escapeHTML(locationName(campaign, state.location)));
	buf += `</div>`;

	const { badges, hms, keyItems } = state.progress;
	const earned: string[] = [];
	if (badges.length) earned.push(`${badges.length}/8 badges`);
	for (const hm of hms) earned.push(describeRequirement(`hm:${hm}`));
	for (const item of keyItems) earned.push(describeRequirement(`item:${item}`));
	if (earned.length) {
		buf += `<div style="text-align:center;color:#666;font-size:9pt;margin-bottom:6px">` +
			Utils.escapeHTML(earned.join(' · ')) + `</div>`;
	}

	buf += `<table style="width:100%">`;
	for (const player of players) {
		buf += Utils.html`<tr><td style="vertical-align:top;padding:4px 12px 4px 0;white-space:nowrap">` +
			Utils.html`<strong>${player.name}</strong></td>`;
		buf += `<td style="vertical-align:top;padding:4px 0">${partyView(player)}</td></tr>`;
	}
	buf += `</table></div>`;
	return buf;
}

export function field(state: AdventureState, campaign: Campaign): string {
	return state.phase === 'lobby' ? lobbyField(state, campaign) : adventureField(state, campaign);
}

/**
 * Board and controls as a single block.
 *
 * These were originally two channels - `|fieldhtml|` for the board and
 * `|controlshtml|` for the buttons - which is what `room-battle-bestof.ts`
 * does. In the rewritten client that does not work: both are queued into the
 * battle's stepQueue, and once the queue is non-empty the battle panel renders
 * its own replay controls straight over whatever `controlshtml` set. The
 * buttons never reach the DOM.
 *
 * So everything goes through the field, which the panel leaves alone.
 */
export function panel(
	state: AdventureState, campaign: Campaign, player: AdventurePlayerState | null, vote: Vote | null,
	actions: ViewerContext = NO_ACTIONS
): string {
	return (
		`<div style="padding:4px">` +
		field(state, campaign) +
		`<hr style="border:none;border-top:1px solid #ccc;margin:8px 0" />` +
		controls(state, campaign, player, vote, actions) +
		`</div>`
	);
}

/* ------------------------------------------------------------------ *
 * The controls: tailored to whoever is looking
 * ------------------------------------------------------------------ */

/** The starter picker, built from the campaign rather than hardcoded. */
function starterControls(roomid: RoomID, campaign: Campaign): string {
	const options = campaign.manifest.starters.map(starter => {
		const label =
			`<psicon pokemon="${Utils.escapeHTML(starter.species)}" /><br />` +
			Utils.html`<strong>${starter.species}</strong><br /><small>${starter.type}</small>`;
		return (
			`<td style="text-align:center;padding:4px">` +
			button(roomid, `/adventure pick ${toID(starter.species)}`, label) +
			Utils.html`<br /><small style="color:#666">${starter.blurb}</small>` +
			`</td>`
		);
	}).join('');

	return (
		`<div style="text-align:center;padding:6px">` +
		`<p style="margin:4px"><strong>Choose your starter</strong></p>` +
		`<table style="margin:0 auto"><tr>${options}</tr></table>` +
		`</div>`
	);
}

/**
 * The travel ballot.
 *
 * Locked destinations render as disabled buttons with the reason underneath,
 * rather than being hidden: a road you can see but cannot take yet is how the
 * map teaches itself, and it makes HMs feel like keys instead of chores.
 */
function voteControls(state: AdventureState, vote: Vote, voterToken: string | null): string {
	const counts = vote.counts();
	const mine = voterToken ? vote.votedFor(voterToken) : undefined;
	const seconds = vote.secondsLeft();

	let buf = `<div style="padding:6px">`;
	buf += `<p style="margin:4px;text-align:center"><strong>${Utils.escapeHTML(vote.title)}</strong> `;
	buf += `<small style="color:#666">${seconds}s left</small></p>`;
	buf += `<table style="margin:0 auto">`;

	for (const option of vote.options) {
		const votes = counts[option.id] || 0;
		const tally = votes ?
			` <small style="color:#666">${'&#9679;'.repeat(Math.min(votes, 6))} ${votes}</small>` : '';
		const chosen = mine === option.id;

		buf += `<tr><td style="padding:3px 6px">`;
		if (option.locked) {
			buf += `<button class="button" disabled>${Utils.escapeHTML(option.label)}</button>`;
		} else {
			const label = (chosen ? `&#10003; ` : ``) + Utils.escapeHTML(option.label);
			buf += button(state.roomid, `/adventure vote ${option.id}`, label, { notifying: chosen });
		}
		buf += tally;
		buf += `</td><td style="padding:3px 6px;color:#888;font-size:9pt">`;
		buf += option.locked ?
			`<span style="color:#b06">${Utils.escapeHTML(option.locked)}</span>` :
			Utils.escapeHTML(option.detail || '');
		buf += `</td></tr>`;
	}

	buf += `</table>`;
	if (!voterToken) {
		buf += `<p style="margin:4px;text-align:center;color:#888;font-size:9pt">Spectators can't vote.</p>`;
	}
	buf += `</div>`;
	return buf;
}

/**
 * A decision the owner owes an answer to, rendered as the first thing they see.
 *
 * Only the oldest is shown. A gauntlet can raise four of these at once, and a
 * wall of prompts is how a player ends up clicking through them without
 * reading - which defeats the point of asking at all.
 */
function pendingControls(
	state: AdventureState, campaign: Campaign, player: AdventurePlayerState
): string {
	const entry = player.pending?.[0];
	if (!entry) return '';

	const pokemon = [...player.party, ...player.box].find(mon => mon.uid === entry.uid);
	if (!pokemon) return '';

	const id = state.roomid;
	const dex = Dex.mod(campaign.mod);
	const remaining = player.pending.length > 1 ?
		` <small style="color:#666">(${player.pending.length - 1} more after this)</small>` : '';

	let buf = `<div style="padding:8px;border:1px solid #b8a; border-radius:4px;margin:6px 0">`;

	if (entry.kind === 'evolve') {
		buf += Utils.html`<p style="margin:2px"><strong>${displayName(pokemon)}</strong> is evolving into ` +
			Utils.html`<strong>${entry.into}</strong>!</p>` + remaining;
		buf += `<p style="margin:6px 2px">`;
		buf += button(id, `/adventure evolve ${pokemon.uid},${toID(entry.into)},yes`, 'Let it evolve', {
			notifying: true,
		});
		buf += ` ` + button(id, `/adventure evolve ${pokemon.uid},${toID(entry.into)},no`, 'Stop it');
		buf += `</p>`;
		buf += `<small style="color:#888">Stopping is not final - it will ask again next level.</small>`;
		buf += `</div>`;
		return buf;
	}

	const move = dex.moves.get(entry.move);
	buf += Utils.html`<p style="margin:2px"><strong>${displayName(pokemon)}</strong> wants to learn ` +
		Utils.html`<strong>${move.name}</strong>` + `</p>` + remaining;
	buf += Utils.html`<p style="margin:2px;color:#666;font-size:9pt">${move.shortDesc || ''} ` +
		Utils.html`(${move.type}, ${move.category})</p>`;
	buf += `<p style="margin:6px 2px;color:#666;font-size:9pt">` +
		`It already knows four moves. Which should it forget?</p>`;

	for (const [slot, known] of pokemon.moves.entries()) {
		const knownMove = dex.moves.get(known);
		buf += `<div style="margin:2px 0">`;
		buf += button(id, `/adventure learn ${pokemon.uid},${entry.move},${slot}`, Utils.escapeHTML(knownMove.name));
		buf += Utils.html` <small style="color:#888">${knownMove.type} &middot; ` +
			Utils.html`${knownMove.category}${knownMove.basePower ? ` · ${knownMove.basePower} BP` : ''}</small>`;
		buf += `</div>`;
	}

	buf += `<p style="margin:6px 2px">` +
		button(id, `/adventure learn ${pokemon.uid},${entry.move},skip`, `Don't learn ${Utils.escapeHTML(move.name)}`) +
		`</p></div>`;
	return buf;
}

/* ------------------------------------------------------------------ *
 * Personal actions
 *
 * Searching, shopping and the box belong to one player, happen whenever that
 * player likes, and never touch the phase machine - so they render below the
 * ballot rather than inside it. Everyone else's adventure carries on while
 * somebody is rummaging through their box.
 * ------------------------------------------------------------------ */

function sectionLabel(text: string): string {
	return `<div style="color:#666;font-size:9pt;margin:8px 0 4px">${Utils.escapeHTML(text)}</div>`;
}

/**
 * The wild-search buttons.
 *
 * Methods the location has but the party cannot use yet - water with no Surf,
 * fishing with no rod - render disabled with the reason beside them, the same
 * way a locked road does on the ballot. Seeing that a route has water is how
 * you learn to come back once you have Surf.
 */
function searchControls(roomid: RoomID, options: SearchOption[]): string {
	if (!options.length) return '';

	let buf = sectionLabel('Wild Pokemon');
	for (const option of options) {
		buf += `<div style="margin:2px 0">`;
		if (option.locked) {
			buf += `<button class="button" disabled>${Utils.escapeHTML(option.label)}</button>`;
			buf += Utils.html` <small style="color:#b06">${option.locked}</small>`;
		} else {
			buf += button(roomid, `/adventure search ${option.method}`, Utils.escapeHTML(option.label));
		}
		buf += `</div>`;
	}
	return buf;
}

/**
 * What you are carrying, and what is for sale where you are standing.
 *
 * These are one section because they are one decision: the only reason to look
 * at the mart is that the bag is looking thin.
 */
function bagControls(
	state: AdventureState, campaign: Campaign, player: AdventurePlayerState, busy: boolean
): string {
	const carried = campaign.balls().filter(ball => (player.bag[ball.id] || 0) > 0);
	const stock = campaign.stockAt(state.location);
	if (!carried.length && !stock.length) return '';

	let buf = sectionLabel('Bag');
	buf += carried.length ?
		carried
			.map(ball => Utils.html`<span style="margin-right:10px">${ball.name} &times;${player.bag[ball.id]}</span>`)
			.join('') :
		`<span style="color:#888">Nothing to throw. Buy a Poke Ball.</span>`;

	if (stock.length) {
		buf += sectionLabel('Poke Mart');
		for (const ball of stock) {
			// `stockAt` only returns priced entries, so this is never undefined.
			const price = ball.price!;
			buf += button(state.roomid, `/adventure buy ${ball.id}`, Utils.escapeHTML(`${ball.name} $${price}`), {
				disabled: busy || player.money < price,
			}) + ` `;
		}
	}
	return buf;
}

/**
 * The party, with the buttons that rearrange it.
 *
 * Order is not cosmetic: `partyToTeam` sends the party as it stands, so
 * whoever is first is who walks into the next battle. And a caught Pokemon
 * that overflowed into the box is unreachable without a way to swap it out,
 * which is what makes this part of catching rather than a nicety beside it.
 */
function partyControls(
	state: AdventureState, campaign: Campaign, player: AdventurePlayerState, busy: boolean
): string {
	const id = state.roomid;
	const max = campaign.manifest.maxPartySize;
	const full = player.party.length >= max;

	let buf = `<div style="text-align:center;color:#666;font-size:9pt;margin-bottom:6px">` +
		`Your party (${player.party.length}/${max})` +
		Utils.html` &middot; $${player.money}</div>`;

	if (!player.party.length) {
		buf += `<div style="text-align:center;color:#888">${partyView(player)}</div>`;
		return buf;
	}

	buf += `<table style="margin:0 auto">`;
	for (const [index, pokemon] of player.party.entries()) {
		buf += `<tr><td style="padding:2px 6px">${pokemonRow(pokemon)}`;
		buf += `<div style="margin-left:24px">${expBar(campaign, pokemon)}</div></td>`;
		buf += `<td style="padding:2px 6px;white-space:nowrap">`;
		if (index > 0) {
			buf += button(id, `/adventure lead ${pokemon.uid}`, 'Lead', { disabled: busy }) + ` `;
		}
		// The last one standing cannot be put away: a player with an empty party
		// has no legal move and nothing to send out.
		if (player.party.length > 1) {
			buf += button(id, `/adventure box ${pokemon.uid}`, 'Box', { disabled: busy });
		}
		buf += `</td></tr>`;
	}
	buf += `</table>`;

	if (player.box.length) {
		buf += sectionLabel(`Box (${player.box.length})`);
		buf += `<table style="margin:0 auto">`;
		for (const pokemon of player.box) {
			buf += `<tr><td style="padding:2px 6px">${pokemonRow(pokemon)}</td>`;
			buf += `<td style="padding:2px 6px;white-space:nowrap">`;
			buf += button(id, `/adventure take ${pokemon.uid}`, 'Take', { disabled: busy || full });
			buf += `</td></tr>`;
		}
		buf += `</table>`;
		if (full) {
			buf += `<p style="text-align:center;color:#888;font-size:9pt;margin:4px">` +
				`Your party is full - box someone first.</p>`;
		}
	}

	if (busy) {
		buf += `<p style="text-align:center;color:#888;font-size:9pt;margin:4px">` +
			`Your party is in a battle; you can rearrange it when that finishes.</p>`;
	}
	return buf;
}

/**
 * Controls for one viewer.
 *
 * `player` is null for anyone watching who hasn't joined - they get a Join
 * button and nothing else.
 */
export function controls(
	state: AdventureState, campaign: Campaign, player: AdventurePlayerState | null, vote: Vote | null,
	actions: ViewerContext = NO_ACTIONS
): string {
	const roomid = state.roomid;

	if (state.phase === 'ended') {
		return `<div style="text-align:center;padding:12px;color:#888">This adventure has ended.</div>`;
	}

	if (state.phase === 'lobby') {
		// Still choosing: the picker is the only thing that matters.
		if (player && !player.party.length) {
			return starterControls(roomid, campaign);
		}

		const players = state.playerOrder.map(token => state.players[token]).filter(Boolean);
		const ready = players.filter(entry => entry.party.length).length;
		const isHost = !!player && player.token === state.host;

		let buf = `<div style="text-align:center;padding:12px">`;
		if (!player) {
			buf += button(roomid, '/adventure join', 'Join this adventure', { notifying: true });
		} else {
			buf += Utils.html`<p style="margin:4px">You chose <strong>${player.party[0].species}</strong>.</p>`;
			if (isHost) {
				const canStart = players.length > 0 && ready === players.length;
				buf += button(roomid, '/adventure start', 'Start adventure', {
					disabled: !canStart,
					notifying: canStart,
				});
				buf += ` `;
			} else {
				buf += `<p style="margin:4px;color:#888;font-size:9pt">Waiting for the host to start.</p>`;
			}
			buf += button(roomid, '/adventure leave', 'Leave');
		}
		buf += `</div>`;
		return buf;
	}

	// Underway.
	if (!player) {
		return (
			`<div style="text-align:center;padding:12px;color:#888">` +
			`You are spectating this adventure.</div>`
		);
	}

	let buf = ``;
	if (vote) {
		buf += voteControls(state, vote, player.token);
		buf += `<hr style="border:none;border-top:1px solid #ddd;margin:4px 0" />`;
	}

	buf += `<div style="padding:8px">`;
	// Before anything else: an unanswered level-up is the one thing on this
	// panel that is waiting on the player rather than the other way round.
	buf += pendingControls(state, campaign, player);
	buf += partyControls(state, campaign, player, actions.busy);
	buf += searchControls(state.roomid, actions.search);
	buf += bagControls(state, campaign, player, actions.busy);
	buf += `</div>`;
	return buf;
}

/* ------------------------------------------------------------------ *
 * The entry page - reachable by link, so nobody has to type a command
 * ------------------------------------------------------------------ */

export function entryPage(campaigns: Campaign[], open: AdventureState[]): string {
	let buf = `<div class="pad"><h2>Adventures</h2>`;
	buf += `<p>Play through a Pokemon game co-op with friends.</p>`;

	if (!campaigns.length) {
		buf += `<p class="message-error">No games are installed on this server.</p></div>`;
		return buf;
	}

	buf += `<h3>Start a new adventure</h3><p>`;
	for (const campaign of campaigns) {
		const region = campaign.manifest.region ? ` (${campaign.manifest.region})` : '';
		buf += `<button class="button" name="send" value="/adventure new ${campaign.id}">` +
			Utils.escapeHTML(`${campaign.name}${region}`) + `</button> `;
	}
	buf += `</p>`;

	buf += `<h3>Open lobbies</h3>`;
	if (!open.length) {
		buf += `<p><em>None right now. Start one above.</em></p>`;
	} else {
		buf += `<ul>`;
		for (const state of open) {
			const count = state.playerOrder.length;
			const hostName = state.players[state.host]?.name || 'someone';
			// Opens the *panel*, not the chat room, and does it with `joinRoom`
			// rather than `send`.
			//
			// `send` posts to the room the button sits in, and this is a page -
			// so the `/join` it used to carry was addressed to something the
			// server has no room for, and the button did nothing whatsoever.
			// Pointing it at the panel is also the better target: the panel is
			// the game, and opening it joins the chat room server-side anyway.
			buf += Utils.html`<li><strong>${hostName}</strong>'s ${state.campaign} run ` +
				`&mdash; ${count} player(s) ` +
				`<button class="button" name="joinRoom" value="view-${state.roomid}">Join</button></li>`;
		}
		buf += `</ul>`;
	}

	buf += `</div>`;
	return buf;
}
