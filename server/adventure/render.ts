/**
 * Adventure - rendering
 *
 * All player-facing HTML lives here, so the game logic never has to think
 * about markup and the markup never has to think about game logic.
 *
 * Everything is server-rendered and pushed into the room as `|uhtml|` or
 * `|controlshtml|`, with `<button name="send" value="/msgroom ...">` for
 * input. That is the same approach `room-battle-bestof.ts` uses for its ready
 * buttons, and it is why this mode needs no client changes.
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

/** A Showdown-style HP bar. */
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

/** One party row: sprite, name, level, HP. */
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
	if (!player.party.length) return `<em>No Pokemon yet.</em>`;
	return player.party.map(pokemon => `<div style="margin:2px 0">${pokemonRow(pokemon)}</div>`).join('');
}

/* ------------------------------------------------------------------ *
 * Lobby
 * ------------------------------------------------------------------ */

/** The starter picker, built from the campaign rather than hardcoded. */
export function starterPicker(roomid: RoomID, campaign: Campaign): string {
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
		`<div class="infobox">` +
		`<p style="margin:6px"><strong>Choose your starter.</strong> ` +
		`<small style="color:#666">Everyone picks their own - duplicates are fine.</small></p>` +
		`<table style="margin:0 auto"><tr>${options}</tr></table>` +
		`</div>`
	);
}

/** The shared lobby panel: who has joined and what they picked. */
export function lobbyView(state: AdventureState, campaign: Campaign, isHost: boolean): string {
	const players = state.playerOrder.map(id => state.players[id]).filter(Boolean);

	let buf = `<div class="infobox">`;
	buf += Utils.html`<h2 style="margin:6px">${campaign.name}</h2>`;
	buf += Utils.html`<p style="margin:6px"><small style="color:#666">${campaign.manifest.region} ` +
		`&middot; waiting to start</small></p>`;

	if (!players.length) {
		buf += `<p style="margin:6px"><em>Nobody has joined yet.</em></p>`;
	} else {
		buf += `<table style="margin:6px">`;
		for (const player of players) {
			const starter = player.party[0];
			const ready = starter ?
				`<psicon pokemon="${Utils.escapeHTML(starter.species)}" /> ${Utils.escapeHTML(starter.species)}` :
				`<small style="color:#888">choosing...</small>`;
			const hostTag = player.id === state.host ? ` <small style="color:#888">(host)</small>` : '';
			buf += Utils.html`<tr><td><strong>${player.name}</strong>` + hostTag + `</td>`;
			buf += `<td style="padding-left:12px">${ready}</td></tr>`;
		}
		buf += `</table>`;
	}

	const ready = players.filter(player => player.party.length).length;
	buf += `<p style="margin:6px">`;
	buf += button(state.roomid, '/adventure join', 'Join');
	buf += ` `;
	buf += button(state.roomid, '/adventure leave', 'Leave');
	if (isHost) {
		buf += ` `;
		const canStart = players.length > 0 && ready === players.length;
		buf += button(state.roomid, '/adventure start', 'Start', {
			disabled: !canStart,
			notifying: canStart,
		});
	}
	buf += `</p>`;

	if (players.length && ready < players.length) {
		buf += `<p style="margin:6px"><small style="color:#666">` +
			`Waiting on ${players.length - ready} player(s) to choose a starter.</small></p>`;
	}

	buf += `</div>`;
	return buf;
}

/* ------------------------------------------------------------------ *
 * Overworld
 * ------------------------------------------------------------------ */

/** Resolves a location id to its display name, falling back to the raw id. */
function locationName(campaign: Campaign, id: string): string {
	return campaign.location(id)?.name || id;
}

/**
 * The status panel once the adventure is underway.
 *
 * Movement and voting land in the next milestone; for now this is the party
 * overview and where everyone is standing.
 */
export function adventureView(state: AdventureState, campaign: Campaign): string {
	const players = state.playerOrder.map(id => state.players[id]).filter(Boolean);

	let buf = `<div class="infobox">`;
	buf += Utils.html`<h2 style="margin:6px">${campaign.name}</h2>`;
	buf += Utils.html`<p style="margin:6px"><strong>${locationName(campaign, state.location)}</strong>` +
		Utils.html` <small style="color:#666">&middot; ${state.phase}</small></p>`;

	buf += `<table style="margin:6px;width:100%">`;
	for (const player of players) {
		const badges = player.badges.length ? ` <small>${player.badges.length} badge(s)</small>` : '';
		buf += Utils.html`<tr><td style="vertical-align:top;padding-right:12px"><strong>${player.name}</strong>` +
			badges + `</td>`;
		buf += `<td style="vertical-align:top">${partyView(player)}</td></tr>`;
	}
	buf += `</table>`;

	buf += `<p style="margin:6px"><small style="color:#666">` +
		`Movement and voting arrive in the next milestone.</small></p>`;
	buf += `</div>`;
	return buf;
}

/** Shown to a single player: their own party in full. */
export function selfView(campaign: Campaign, player: AdventurePlayerState): string {
	let buf = `<div class="infobox"><p style="margin:6px"><strong>Your party</strong> `;
	buf += `<small style="color:#666">${player.party.length}/${campaign.manifest.maxPartySize}</small></p>`;
	buf += `<div style="margin:6px">${partyView(player)}</div>`;
	buf += Utils.html`<p style="margin:6px"><small>Money: $${player.money}</small></p>`;
	buf += `</div>`;
	return buf;
}
