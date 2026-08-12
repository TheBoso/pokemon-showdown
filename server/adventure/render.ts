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
import {
	displayName, isFainted,
	type AdventurePlayerState, type AdventureState, type PartyPokemon,
} from './state';

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

	buf += `<table style="width:100%">`;
	for (const player of players) {
		const badges = player.badges.length ?
			` <small style="color:#666">${player.badges.length} badge(s)</small>` : '';
		buf += Utils.html`<tr><td style="vertical-align:top;padding:4px 12px 4px 0;white-space:nowrap">` +
			Utils.html`<strong>${player.name}</strong>` + badges + `</td>`;
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
	state: AdventureState, campaign: Campaign, player: AdventurePlayerState | null
): string {
	return (
		`<div style="padding:4px">` +
		field(state, campaign) +
		`<hr style="border:none;border-top:1px solid #ccc;margin:8px 0" />` +
		controls(state, campaign, player) +
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
 * Controls for one viewer.
 *
 * `player` is null for anyone watching who hasn't joined - they get a Join
 * button and nothing else.
 */
export function controls(
	state: AdventureState, campaign: Campaign, player: AdventurePlayerState | null
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

	let buf = `<div style="padding:8px">`;
	buf += `<div style="text-align:center;color:#666;font-size:9pt;margin-bottom:6px">` +
		`Your party (${player.party.length}/${campaign.manifest.maxPartySize})` +
		Utils.html` &middot; $${player.money}</div>`;
	buf += `<div style="text-align:center">${partyView(player)}</div>`;
	buf += `<div style="text-align:center;margin-top:8px;color:#888;font-size:9pt">` +
		`Movement and voting arrive in the next milestone.</div>`;
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
			buf += Utils.html`<li><strong>${hostName}</strong>'s ${state.campaign} run ` +
				`&mdash; ${count} player(s) ` +
				`<button class="button" name="send" value="/join ${state.roomid}">Join</button></li>`;
		}
		buf += `</ul>`;
	}

	buf += `</div>`;
	return buf;
}
