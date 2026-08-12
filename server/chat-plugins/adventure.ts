/**
 * Adventure - commands
 *
 * A co-op playthrough of a Pokemon game, built on the battle framework.
 * The engine lives in server/adventure/; this file is only the command
 * surface and the buttons that drive it.
 *
 * Games are data, not code: `/adventure new emerald` looks up a campaign in
 * data/campaigns/, so a new game needs no changes here.
 */

import { Adventure } from '../adventure/adventure';
import { allCampaigns, campaignNames, getCampaign, reloadCampaigns } from '../adventure/campaigns';

/** One adventure hosted per person, so a single user can't fill the room list. */
function findHostedAdventure(user: User): Adventure | null {
	for (const room of Rooms.rooms.values()) {
		const game = room.game;
		if (game?.gameid === 'adventure' && (game as Adventure).state.host === user.id) {
			return game as Adventure;
		}
	}
	return null;
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

export const commands: Chat.ChatCommands = {
	adv: 'adventure',
	adventure: {
		''(target, room, user) {
			return this.parse('/adventure help');
		},

		create: 'new',
		new(target, room, user) {
			this.checkChat();
			if (!user.named) {
				throw new Chat.ErrorMessage(`You need to choose a username before starting an adventure.`);
			}

			const campaigns = allCampaigns();
			if (!campaigns.length) {
				throw new Chat.ErrorMessage(`No campaigns are installed on this server.`);
			}

			// A single installed campaign doesn't need naming.
			const id = toID(target) || (campaigns.length === 1 ? campaigns[0].id : '');
			if (!id) {
				throw new Chat.ErrorMessage(`Which game? Available: ${campaignNames()}.`);
			}

			const campaign = getCampaign(id);
			if (!campaign) {
				throw new Chat.ErrorMessage(`There's no campaign called "${id}". Available: ${campaignNames()}.`);
			}

			const existing = findHostedAdventure(user);
			if (existing) {
				throw new Chat.ErrorMessage(
					`You are already hosting an adventure in <<${existing.state.roomid}>>. ` +
					`End it first with /adventure end.`
				);
			}

			const game = Adventure.create(user, campaign);
			this.sendReply(`Created a ${campaign.name} adventure: <<${game.state.roomid}>>`);
			return this.sendReply(`Invite friends by sending them that room link.`);
		},
		newhelp: [`/adventure new [game] - Creates a new adventure room and puts you in it as host.`],

		games: 'list',
		list(target, room, user) {
			this.runBroadcast();
			const campaigns = allCampaigns();
			if (!campaigns.length) return this.sendReply(`No campaigns are installed on this server.`);

			const rows = campaigns.map(campaign => {
				const region = campaign.manifest.region ? ` (${campaign.manifest.region})` : '';
				return `<li><strong>${campaign.id}</strong> - ${campaign.name}${region}</li>`;
			}).join('');
			return this.sendReplyBox(`<strong>Available games</strong><ul>${rows}</ul>`);
		},
		listhelp: [`/adventure list - Shows which games can be played.`],

		join(target, room, user) {
			room = this.requireRoom();
			const game = this.requireGame(Adventure);
			this.checkChat();
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
			this.checkChat();
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
			this.checkChat();
			game.start(user);
		},
		starthelp: [`/adventure start - Starts the adventure. Host only; everyone needs a starter first.`],

		party(target, room, user) {
			room = this.requireRoom();
			const game = this.requireGame(Adventure);
			const player = game.playerTable[user.id];
			if (!player) throw new Chat.ErrorMessage(`You are not in this adventure.`);
			game.updatePlayerView(player);
		},
		partyhelp: [`/adventure party - Re-displays your party panel.`],

		end(target, room, user) {
			room = this.requireRoom();
			const game = this.requireGame(Adventure);
			if (game.state.host !== user.id && !user.can('minigame', null, room)) {
				throw new Chat.ErrorMessage(`Only the host can end this adventure.`);
			}
			game.end(user);
		},
		endhelp: [`/adventure end - Ends the adventure and closes the room. Host or staff only.`],

		reloadcampaigns(target, room, user) {
			this.checkCan('rangeban');
			reloadCampaigns();
			for (const activeRoom of Rooms.rooms.values()) {
				const game = activeRoom.game;
				if (game?.gameid === 'adventure') (game as Adventure).campaign.reload();
			}
			return this.sendReply(`Reloaded campaign data. Available: ${campaignNames()}.`);
		},
		reloadcampaignshelp: [
			`/adventure reloadcampaigns - Re-reads data/campaigns from disk. Requires: &`,
		],

		help(target, room, user) {
			return this.parse('/help adventure');
		},
	},

	adventurehelp: [
		`/adventure new [game] - Creates a new adventure room and puts you in it as host.`,
		`/adventure list - Shows which games can be played.`,
		`/adventure join - Joins the adventure in this room, before it starts.`,
		`/adventure leave - Leaves the adventure, before it starts.`,
		`/adventure pick [starter] - Chooses your starter.`,
		`/adventure start - Starts the adventure. Host only.`,
		`/adventure party - Re-displays your party panel.`,
		`/adventure end - Ends the adventure and closes the room. Host or staff only.`,
	],
};
