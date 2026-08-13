/**
 * Adventure - wild encounters
 *
 * Rolling what turns up when someone searches. Encounters are personal and
 * unsynced: each player presses their own button and gets their own result, so
 * this takes a PRNG rather than the adventure's shared one.
 */

import type { PRNG } from '../../sim/prng';
import type { Campaign, EncounterEntry, EncounterMethod } from './campaigns';

export interface Encounter {
	species: string;
	level: number;
	method: string;
}

/**
 * One search button, as offered to a player standing somewhere.
 *
 * Lives here rather than in adventure.ts because render.ts needs it and must
 * not import the game - the dependency runs the other way.
 */
export interface SearchOption {
	method: string;
	label: string;
	/** Why the button is shut, if it is. Absent means it works. */
	locked?: string;
}

/** The methods a location offers, in the order they should be shown. */
const METHOD_ORDER = ['land', 'surf', 'rocksmash', 'oldrod', 'goodrod', 'superrod'];

/** What a method is called in the UI, and what it needs to be usable. */
export const METHOD_INFO: { [method: string]: { label: string, requires?: string } } = {
	land: { label: 'Search the grass' },
	surf: { label: 'Search the water', requires: 'hm:surf' },
	rocksmash: { label: 'Smash rocks', requires: 'hm:rocksmash' },
	oldrod: { label: 'Fish (Old Rod)', requires: 'item:oldrod' },
	goodrod: { label: 'Fish (Good Rod)', requires: 'item:goodrod' },
	superrod: { label: 'Fish (Super Rod)', requires: 'item:superrod' },
};

export function methodsAt(campaign: Campaign, locationId: string): string[] {
	const available = new Set(campaign.encounterMethods(locationId));
	return METHOD_ORDER.filter(method => available.has(method));
}

/**
 * Picks a slot by weight.
 *
 * Slot rates total 100 within a method, but they are rounded when generated, so
 * this samples across whatever they actually sum to rather than assuming 100.
 */
function pickSlot(slots: EncounterEntry[], prng: PRNG): EncounterEntry | null {
	if (!slots.length) return null;
	const total = slots.reduce((sum, slot) => sum + slot.rate, 0);
	if (total <= 0) return prng.sample(slots);

	// random() is [0,1), so this never overshoots the last slot.
	let roll = prng.random() * total;
	for (const slot of slots) {
		roll -= slot.rate;
		if (roll < 0) return slot;
	}
	return slots[slots.length - 1];
}

/**
 * Searches for a wild Pokemon.
 *
 * Returns null when nothing turned up - which is most of the time, since the
 * ROM's per-method encounter rate is the chance a step finds anything at all.
 * A miss is a real outcome, not an error.
 */
export function rollEncounter(
	campaign: Campaign, locationId: string, method: string, prng: PRNG
): Encounter | null {
	const table = campaign.encounterTable(locationId);
	const entry: EncounterMethod | undefined = table?.[method];
	if (!entry?.slots.length) return null;

	// `rate` is out of 100-ish; treat anything at or above 100 as certain.
	if (entry.rate < 100 && prng.random(100) >= entry.rate) return null;

	const slot = pickSlot(entry.slots, prng);
	if (!slot) return null;

	const spread = Math.max(0, slot.maxLevel - slot.minLevel);
	const level = slot.minLevel + (spread ? prng.random(spread + 1) : 0);
	return { species: slot.species, level, method };
}

/**
 * Everything a location can turn up, for showing players what lives here.
 *
 * Collapsed by species across level bands. The tables keep bands separate
 * because a Lv2 and a Lv3 Wurmple really are different slots, but "Wurmple
 * (Lv2) | Wurmple (Lv3)" is noise to read - one "Wurmple (Lv2-3)" is not.
 */
export function encounterSummary(campaign: Campaign, locationId: string, method: string): string[] {
	const entry = campaign.encounterTable(locationId)?.[method];
	if (!entry) return [];

	const merged = new Map<string, { min: number, max: number, rate: number }>();
	for (const slot of entry.slots) {
		const existing = merged.get(slot.species);
		if (existing) {
			existing.min = Math.min(existing.min, slot.minLevel);
			existing.max = Math.max(existing.max, slot.maxLevel);
			existing.rate += slot.rate;
		} else {
			merged.set(slot.species, { min: slot.minLevel, max: slot.maxLevel, rate: slot.rate });
		}
	}

	return [...merged.entries()]
		.sort((a, b) => b[1].rate - a[1].rate)
		.map(([species, { min, max }]) => (
			min === max ? `${species} (Lv${min})` : `${species} (Lv${min}-${max})`
		));
}
