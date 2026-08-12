/**
 * Adventure - commands and entry page
 *
 * A co-op playthrough of a Pokemon game, built on the battle framework.
 * The engine lives in server/adventure/.
 *
 * These commands exist to back buttons, not to be typed. The adventure UI is
 * rendered into the room's `|controlshtml|`, and every button sends one of
 * these via `/msgroom`. Nothing here calls `checkChat()`, so the buttons work
 * for guests, for muted users, and in rooms under modchat - clicking a button
 * in a game you are already in is not "talking".
 *
 * `/view-adventure` is the entry point, so starting an adventure needs a link
 * rather than a command typed into lobby.
 *
 * Games are data, not code: `/adventure new emerald` looks up a campaign in
 * data/campaigns/, so a new game needs no changes here.
 */

import { Adventure } from '../adventure/adventure';
import { allCampaigns, campaignNames, getCampaign, reloadCampaigns } from '../adventure/campaigns';
import { entryPage } from '../adventure/render';
import type { AdventureState } from '../adventure/state';

function eachAdventure(): Adventure[] {
	const found: Adventure[] = [];
	for (const room of Rooms.rooms.values()) {
		if (room.game?.gameid === 'adventure') found.push(room.game as Adventure);
	}
	return found;
}

/** One adventure hosted per person, so a single user can't fill the room list. */
function findHostedAdventure(user: User): Adventure | null {
	for (const game of eachAdventure()) {
		const token = game.state.playerTokens[user.id];
		if (token && game.state.host === token) return game;
	}
	return null;
}

/** Lobbies anyone can still join. */
function openLobbies(): AdventureState[] {
	return eachAdventure()
		.filter(game => game.state.phase === 'lobby' && !game.ended)
		.map(game => game.state);
}

/**
 * Adventures are restored on plugin load rather than server boot, because that
 * is the first point at which this code exists. Battle subprocesses also load
 * chat plugins, and they must not resurrect rooms - hence the guard.
 */
if (!process.send) {
	try {
		Adventure.restoreAll();
	} catch (err: any) {
		Monitor.crashlog(err, 'Adventure restoreAll');
	}
}

export const pages: Chat.PageTable = {
	/**
	 * `view-adventure` is the front door; `view-adventure-3` is the live panel
	 * for the adventure in room `adventure-3`.
	 *
	 * Opening the page registers it in `connection.openPages`, which is what
	 * lets the game push repaints to it without the client asking.
	 */
	adventure(query, user, connection) {
		const id = toID(query.join('-'));
		if (!id) {
			this.title = 'Adventures';
			return entryPage(allCampaigns(), openLobbies());
		}

		const room = Rooms.get(`adventure-${id}` as RoomID);
		const game = room?.game?.gameid === 'adventure' ? room.game as Adventure : null;
		if (!game) {
			this.title = 'Adventure';
			return `<div class="pad"><h2>Adventure not found</h2>` +
				`<p>It may have ended. <button class="button" name="joinRoom" value="view-adventure">` +
				`Back to adventures</button></p></div>`;
		}

		this.title = game.campaign.name;
		return game.panelFor(user);
	},
};

export const commands: Chat.ChatCommands = {
	adv: 'adventure',
	adventure: {
		''(target, room, user) {
			// Bare /adventure opens the entry page rather than printing help,
			// since the page is the actual front door.
			return this.parse('/join view-adventure');
		},

		create: 'new',
		new(target, room, user) {
			const campaigns = allCampaigns();
			if (!campaigns.length) {
				throw new Chat.ErrorMessage(`No games are installed on this server.`);
			}

			// A single installed campaign doesn't need naming.
			const id = toID(target) || (campaigns.length === 1 ? campaigns[0].id : '');
			if (!id) {
				throw new Chat.ErrorMessage(`Which game? Available: ${campaignNames()}.`);
			}

			const campaign = getCampaign(id);
			if (!campaign) {
				throw new Chat.ErrorMessage(`There's no game called "${id}". Available: ${campaignNames()}.`);
			}

			const existing = findHostedAdventure(user);
			if (existing) {
				throw new Chat.ErrorMessage(
					`You are already hosting an adventure in <<${existing.state.roomid}>>. End that one first.`
				);
			}

			const game = Adventure.create(user, campaign);
			return this.sendReply(
				`Created a ${campaign.name} adventure: <<${game.state.roomid}>> - ` +
				`send that room link to whoever you want to play with.`
			);
		},
		newhelp: [`/adventure new [game] - Creates a new adventure room and puts you in it as host.`],

		games: 'list',
		list(target, room, user) {
			return this.parse('/join view-adventure');
		},
		listhelp: [`/adventure list - Opens the adventure page.`],

		join(target, room, user) {
			room = this.requireRoom();
			const game = this.requireGame(Adventure);
			game.joinGame(user);
		},
		joinhelp: [`/adventure join - Joins the adventure in this room. Only possible before it starts.`],

		leave(target, room, user) {
			room = this.requireRoom();
			const game = this.requireGame(Adventure);
			game.leaveGame(user);
		},
		leavehelp: [`/adventure leave - Leaves the adventure in this room. Only possible before it starts.`],

		choose: 'pick',
		starter: 'pick',
		pick(target, room, user) {
			room = this.requireRoom();
			const game = this.requireGame(Adventure);
			if (!target) {
				const names = game.campaign.manifest.starters.map(starter => starter.species).join(', ');
				throw new Chat.ErrorMessage(`Which starter? Choose from: ${names}.`);
			}
			game.pickStarter(user, toID(target));
		},
		pickhelp: [`/adventure pick [starter] - Chooses your starter from the campaign's list.`],

		start(target, room, user) {
			room = this.requireRoom();
			const game = this.requireGame(Adventure);
			game.start(user);
		},
		starthelp: [`/adventure start - Starts the adventure. Host only; everyone needs a starter first.`],

		go: 'vote',
		travel: 'vote',
		vote(target, room, user) {
			room = this.requireRoom();
			const game = this.requireGame(Adventure);
			if (!target) throw new Chat.ErrorMessage(`Vote for what? Use the buttons on the adventure panel.`);
			game.castVote(user, target.trim());
		},
		votehelp: [`/adventure vote [destination] - Votes for where the party goes next.`],

		forcevote(target, room, user) {
			room = this.requireRoom();
			const game = this.requireGame(Adventure);
			const token = game.state.playerTokens[user.id];
			if (game.state.host !== token && !user.can('minigame', null, room)) {
				throw new Chat.ErrorMessage(`Only the host can close the vote early.`);
			}
			if (!game.vote) throw new Chat.ErrorMessage(`There is no vote open.`);
			game.vote.resolve();
		},
		forcevotehelp: [`/adventure forcevote - Closes the current vote immediately. Host or staff only.`],

		refresh(target, room, user, connection) {
			room = this.requireRoom();
			const game = this.requireGame(Adventure);
			game.onConnect(user, connection);
		},
		refreshhelp: [`/adventure refresh - Repaints the adventure display.`],

		end(target, room, user) {
			room = this.requireRoom();
			const game = this.requireGame(Adventure);
			const token = game.state.playerTokens[user.id];
			if (game.state.host !== token && !user.can('minigame', null, room)) {
				throw new Chat.ErrorMessage(`Only the host can end this adventure.`);
			}
			game.end(user);
		},
		endhelp: [`/adventure end - Ends the adventure and closes the room. Host or staff only.`],

		reloadcampaigns(target, room, user) {
			this.checkCan('rangeban');
			reloadCampaigns();
			for (const game of eachAdventure()) game.campaign.reload();
			return this.sendReply(`Reloaded campaign data. Available: ${campaignNames()}.`);
		},
		reloadcampaignshelp: [`/adventure reloadcampaigns - Re-reads data/campaigns from disk. Requires: &`],

		help(target, room, user) {
			return this.parse('/help adventure');
		},
	},

	adventurehelp: [
		`Adventures are a co-op playthrough of a Pokemon game.`,
		`Open <<view-adventure>> to start or join one - the rest is buttons.`,
		``,
		`/adventure new [game] - Creates a new adventure room and puts you in it as host.`,
		`/adventure end - Ends the adventure and closes the room. Host or staff only.`,
	],
};
