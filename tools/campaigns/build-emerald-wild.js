'use strict';
/**
 * Generates the wild-encounter data for the Emerald campaign:
 *
 *   data/campaigns/emerald/encounters.json    what appears where, and how often
 *   data/campaigns/emerald/species-extra.json catch rate, base EXP, growth rate
 *
 * Both are exact numbers with no design judgement in them, so both are
 * generated rather than curated - unlike the location graph.
 *
 * Sources:
 *   src/data/wild_encounters.json    already JSON; slot rates are positional
 *   src/data/pokemon/species_info.h  the three fields Showdown's dex lacks
 *
 * Usage:
 *   node tools/campaigns/build-emerald-wild.js [path-to-pokeemerald]
 */

const fs = require('fs');
const path = require('path');

const PS_ROOT = path.resolve(__dirname, '../..');
const DECOMP = process.argv[2] || 'D:/Projects/Personal/PokemonThing/pokeemerald';

const { SPLIT_MAPS, toCampaignId } = require('./emerald-maps');

const { Dex } = require(path.join(PS_ROOT, 'dist/sim'));
global.Dex = Dex;
global.toID = Dex.toID;
const dex = Dex.mod('gen3');

const warnings = [];
function warn(message) {
	if (warnings.length < 30) warnings.push(message);
}

function read(relative) {
	const file = path.join(DECOMP, relative);
	if (!fs.existsSync(file)) {
		console.error(`Missing ${relative} under ${DECOMP}.`);
		process.exit(2);
	}
	return fs.readFileSync(file, 'utf8');
}

/**
 * Placeholder entries the ROM keeps but never uses: the null species, and the
 * 26 OLD_UNOWN slots left over from a scrapped per-letter representation.
 */
const NOT_REAL_SPECIES = /^SPECIES_(NONE|OLD_UNOWN_[A-Z])$/;

function resolveSpecies(constant) {
	if (NOT_REAL_SPECIES.test(constant)) return null;
	const species = dex.species.get(toID(constant.replace(/^SPECIES_/, '')));
	if (!species.exists) {
		warn(`unknown species ${constant}`);
		return null;
	}
	return species.name;
}

/* ------------------------------------------------------------------ *
 * Encounters
 * ------------------------------------------------------------------ */

/** ROM field names -> the method names the game uses. */
const METHODS = {
	land_mons: 'land',
	water_mons: 'surf',
	rock_smash_mons: 'rocksmash',
};

/** Fishing is one ROM field split into three rods by slot index. */
const ROD_GROUPS = { old_rod: 'oldrod', good_rod: 'goodrod', super_rod: 'superrod' };

const wild = JSON.parse(read('src/data/wild_encounters.json'));
const group = wild.wild_encounter_groups.find(entry => entry.label === 'gWildMonHeaders');
if (!group) {
	console.error(`No gWildMonHeaders group in wild_encounters.json.`);
	process.exit(2);
}

/** field type -> positional slot rates */
const slotRates = {};
/** fishing rod -> slot indexes */
let fishingGroups = {};
for (const field of group.fields) {
	slotRates[field.type] = field.encounter_rates;
	if (field.groups) fishingGroups = field.groups;
}

const campaignLocations = new Set(
	Object.keys(JSON.parse(fs.readFileSync(
		path.join(PS_ROOT, 'data/campaigns/emerald/locations.json'), 'utf8'
	))).filter(id => !id.startsWith('_'))
);

/**
 * Merges slots that name the same species at the same levels.
 *
 * The ROM lists a species once per slot, so a Pokemon on four slots appears
 * four times. Rolling a slot and rolling a merged weight are equivalent, and
 * merged reads far better in a UI.
 */
function mergeSlots(entries) {
	const merged = new Map();
	for (const entry of entries) {
		const key = `${entry.species}|${entry.minLevel}|${entry.maxLevel}`;
		const existing = merged.get(key);
		if (existing) {
			existing.rate += entry.rate;
		} else {
			merged.set(key, { ...entry });
		}
	}
	return [...merged.values()].sort((a, b) => b.rate - a.rate);
}

function buildMethod(monList, rates, encounterRate, indexes = null) {
	const slots = [];
	monList.forEach((mon, index) => {
		if (indexes && !indexes.includes(index)) return;
		const species = resolveSpecies(mon.species);
		if (!species) return;
		slots.push({
			species,
			minLevel: mon.min_level,
			maxLevel: mon.max_level,
			rate: rates[index] || 0,
		});
	});
	if (!slots.length) return null;

	// Rod groups only use some slots, so their rates do not total 100.
	const total = slots.reduce((sum, slot) => sum + slot.rate, 0) || 1;
	const normalised = mergeSlots(slots).map(slot => ({
		...slot,
		rate: Math.round((slot.rate / total) * 1000) / 10,
	}));
	return { rate: encounterRate, slots: normalised };
}

const tables = {};
const offMap = new Set();
let placed = 0;

for (const encounter of group.encounters) {
	let location = toCampaignId(encounter.map);
	if (SPLIT_MAPS[location]) [location] = SPLIT_MAPS[location];

	if (!campaignLocations.has(location)) {
		offMap.add(location);
		continue;
	}

	const table = tables[location] || {};

	for (const [field, method] of Object.entries(METHODS)) {
		const data = encounter[field];
		if (!data?.mons?.length) continue;
		const built = buildMethod(data.mons, slotRates[field] || [], data.encounter_rate);
		if (built) table[method] = built;
	}

	const fishing = encounter.fishing_mons;
	if (fishing?.mons?.length) {
		for (const [romRod, rod] of Object.entries(ROD_GROUPS)) {
			const indexes = fishingGroups[romRod];
			if (!indexes) continue;
			const built = buildMethod(
				fishing.mons, slotRates.fishing_mons || [], fishing.encounter_rate, indexes
			);
			if (built) table[rod] = built;
		}
	}

	if (Object.keys(table).length) {
		// A campaign location can cover several ROM maps (Granite Cave's floors);
		// later ones merge in rather than replacing.
		tables[location] = { ...tables[location], ...table };
		placed++;
	}
}

fs.writeFileSync(
	path.join(PS_ROOT, 'data/campaigns/emerald/encounters.json'),
	`${JSON.stringify({
		_comment: [
			'GENERATED by tools/campaigns/build-emerald-wild.js - do not hand-edit.',
			'Source: pokeemerald src/data/wild_encounters.json.',
			'',
			'`rate` on a method is the ROM encounter_rate: roughly how often a step',
			'finds anything at all. `rate` on a slot is that slot\'s share of the',
			'encounters, as a percentage totalling 100 within the method.',
			'',
			'The ROM lists a species once per slot, so a Pokemon occupying four',
			'slots appeared four times; identical entries are merged and their',
			'rates summed, which is equivalent and reads better.',
		],
		tables,
	}, null, '\t')}\n`
);

/* ------------------------------------------------------------------ *
 * Species extras
 * ------------------------------------------------------------------ */

const GROWTH_RATES = {
	GROWTH_MEDIUM_FAST: 'mediumfast',
	GROWTH_ERRATIC: 'erratic',
	GROWTH_FLUCTUATING: 'fluctuating',
	GROWTH_MEDIUM_SLOW: 'mediumslow',
	GROWTH_FAST: 'fast',
	GROWTH_SLOW: 'slow',
};

const speciesExtra = {};
{
	const source = read('src/data/pokemon/species_info.h');
	let current = null;
	let entry = null;

	const flush = () => {
		if (!current || !entry) return;
		const species = resolveSpecies(current);
		if (species && entry.catchRate !== undefined) {
			speciesExtra[toID(species)] = {
				catchRate: entry.catchRate,
				baseExp: entry.baseExp ?? 0,
				growthRate: entry.growthRate || 'mediumfast',
			};
		}
		entry = null;
	};

	for (const rawLine of source.split('\n')) {
		const line = rawLine.trim();

		const header = /^\[(SPECIES_\w+)\]/.exec(line);
		if (header) {
			flush();
			current = header[1];
			entry = {};
			continue;
		}
		if (!entry) continue;

		const catchRate = /^\.catchRate\s*=\s*(\d+)/.exec(line);
		if (catchRate) { entry.catchRate = Number(catchRate[1]); continue; }

		const expYield = /^\.expYield\s*=\s*(\d+)/.exec(line);
		if (expYield) { entry.baseExp = Number(expYield[1]); continue; }

		const growth = /^\.growthRate\s*=\s*(GROWTH_\w+)/.exec(line);
		if (growth) { entry.growthRate = GROWTH_RATES[growth[1]] || 'mediumfast'; continue; }
	}
	flush();
}

fs.writeFileSync(
	path.join(PS_ROOT, 'data/campaigns/emerald/species-extra.json'),
	`${JSON.stringify({
		_comment: [
			'GENERATED by tools/campaigns/build-emerald-wild.js - do not hand-edit.',
			'Source: pokeemerald src/data/pokemon/species_info.h.',
			'',
			'The three fields Showdown\'s dex does not carry: catch rate (0-255,',
			'higher is easier), base EXP yield, and which of the six growth curves',
			'the species levels on.',
		],
		species: speciesExtra,
	}, null, '\t')}\n`
);

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

console.log(`Reading ${DECOMP}`);
console.log(`\nWrote data/campaigns/emerald/encounters.json`);
console.log(`  ${Object.keys(tables).length} locations with wild Pokemon (${placed} ROM maps merged in)`);
console.log(`  ${offMap.size} encounter map(s) the campaign does not model`);

const withoutEncounters = [...campaignLocations].filter(id => !tables[id]);
console.log(`  ${withoutEncounters.length}/${campaignLocations.size} campaign locations have none`);

console.log(`\nWrote data/campaigns/emerald/species-extra.json`);
console.log(`  ${Object.keys(speciesExtra).length} species`);

if (warnings.length) {
	console.log(`\nWarnings:`);
	for (const line of warnings) console.log(`  ${line}`);
}
