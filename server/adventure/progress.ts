/**
 * Adventure - shared progress and requirement checking
 *
 * Badges, HMs, key items and story flags are held by the *group*, not by
 * individual players. Everyone travels together, so a gate that opened for one
 * player and not another would be nonsense: the party would be split across
 * two locations with no way to model it.
 *
 * This is where location requirement tokens (`hm:surf`, `badge:stone`) get
 * turned into yes/no, and into something readable when the answer is no.
 */

import type { Requirement } from './campaigns';

export interface Progress {
	badges: string[];
	hms: string[];
	keyItems: string[];
	flags: string[];
}

export function emptyProgress(): Progress {
	return { badges: [], hms: [], keyItems: [], flags: [] };
}

/** The list a requirement of this type is satisfied from. */
function listFor(progress: Progress, type: string): string[] | null {
	switch (type) {
	case 'badge': return progress.badges;
	case 'hm': return progress.hms;
	case 'item': return progress.keyItems;
	case 'flag': return progress.flags;
	default: return null;
	}
}

export function meetsRequirement(progress: Progress, requirement: Requirement): boolean {
	const [type, value] = requirement.split(':');
	const list = listFor(progress, type);
	// An unknown requirement type is treated as unmet rather than ignored: a
	// typo should lock a road loudly, not silently open one.
	if (!list) return false;
	return list.includes(value);
}

export function meetsAll(progress: Progress, requirements: Requirement[] = []): boolean {
	return requirements.every(requirement => meetsRequirement(progress, requirement));
}

/** The requirements in `requirements` that are not yet satisfied. */
export function unmet(progress: Progress, requirements: Requirement[] = []): Requirement[] {
	return requirements.filter(requirement => !meetsRequirement(progress, requirement));
}

export function grant(progress: Progress, requirement: Requirement): void {
	const [type, value] = requirement.split(':');
	const list = listFor(progress, type);
	if (list && value && !list.includes(value)) list.push(value);
}

/* ------------------------------------------------------------------ *
 * Readable names
 * ------------------------------------------------------------------ */

const HM_NAMES: { [id: string]: string } = {
	cut: 'Cut',
	fly: 'Fly',
	surf: 'Surf',
	strength: 'Strength',
	flash: 'Flash',
	rocksmash: 'Rock Smash',
	waterfall: 'Waterfall',
	dive: 'Dive',
};

const BADGE_NAMES: { [id: string]: string } = {
	stone: 'Stone Badge',
	knuckle: 'Knuckle Badge',
	dynamo: 'Dynamo Badge',
	heat: 'Heat Badge',
	balance: 'Balance Badge',
	feather: 'Feather Badge',
	mind: 'Mind Badge',
	rain: 'Rain Badge',
};

const ITEM_NAMES: { [id: string]: string } = {
	gogoggles: 'Go-Goggles',
	devonscope: 'Devon Scope',
	magmaemblem: 'Magma Emblem',
	machbike: 'Mach Bike',
	acrobike: 'Acro Bike',
};

/** Story beats, phrased as the thing the party still has to do. */
const FLAG_NAMES: { [id: string]: string } = {
	briney_rescued: `Mr. Briney's help`,
	magma_route112_cleared: 'Team Magma cleared from Route 112',
	mt_chimney_cleared: 'Mt. Chimney resolved',
	magma_hideout_cleared: 'the Magma Hideout dealt with',
	kyogre_groudon_stopped: 'the weather crisis ended',
};

/** Turns `hm:surf` into `Surf`, for telling a player why a road is shut. */
export function describeRequirement(requirement: Requirement): string {
	const [type, value] = requirement.split(':');
	switch (type) {
	case 'hm': return HM_NAMES[value] || value;
	case 'badge': return BADGE_NAMES[value] || `${value} badge`;
	case 'item': return ITEM_NAMES[value] || value;
	case 'flag': return FLAG_NAMES[value] || value.replace(/_/g, ' ');
	default: return requirement;
	}
}

export function describeAll(requirements: Requirement[]): string {
	return requirements.map(describeRequirement).join(' + ');
}
