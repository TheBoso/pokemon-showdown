'use strict';
/**
 * Generates data/campaigns/emerald/trainers.json from the pokeemerald decomp.
 *
 * Unlike the location graph, this IS generated: trainer rosters are exact
 * numbers with no design judgement in them, and there are several hundred.
 * Hand-copying would be slower and wrong.
 *
 * Three files carry the data:
 *   src/data/trainers.h        identity, class, AI flags, party pointer
 *   src/data/trainer_parties.h the actual Pokemon
 *   data/maps/<Map>/scripts.inc  which trainers stand where
 *
 * Usage:
 *   node tools/campaigns/build-emerald-trainers.js [path-to-pokeemerald]
 */

const fs = require('fs');
const path = require('path');

const PS_ROOT = path.resolve(__dirname, '../..');
const DECOMP = process.argv[2] || 'D:/Projects/Personal/PokemonThing/pokeemerald';
const OUT = path.join(PS_ROOT, 'data/campaigns/emerald/trainers.json');

const { SPLIT_MAPS, toCampaignId } = require('./emerald-maps');

// Showdown's dex does the species/move/item name resolution for us.
const { Dex } = require(path.join(PS_ROOT, 'dist/sim'));
global.Dex = Dex;
global.toID = Dex.toID;
const { levelUpMoveset } = require(path.join(PS_ROOT, 'dist/server/adventure/state'));

const MOD = 'gen3';
const dex = Dex.mod(MOD);

/** Gen 3 stores one IV byte per trainer mon and applies it to all six stats. */
const MAX_PER_STAT_IVS = 31;
function ivFromByte(byte) {
	return Math.floor((byte * MAX_PER_STAT_IVS) / 255);
}

function read(relative) {
	const file = path.join(DECOMP, relative);
	if (!fs.existsSync(file)) {
		console.error(`Missing ${relative} under ${DECOMP}.`);
		console.error(`Usage: node tools/campaigns/build-emerald-trainers.js <path-to-pokeemerald>`);
		process.exit(2);
	}
	return fs.readFileSync(file, 'utf8');
}

const warnings = [];
function warn(message) {
	if (warnings.length < 40) warnings.push(message);
}

/* ------------------------------------------------------------------ *
 * Name resolution
 * ------------------------------------------------------------------ */

/** SPECIES_MR_MIME -> Mr. Mime, via Showdown's own id normalisation. */
function resolveSpecies(constant) {
	const id = toID(constant.replace(/^SPECIES_/, ''));
	const species = dex.species.get(id);
	if (!species.exists) {
		warn(`unknown species ${constant}`);
		return null;
	}
	return species;
}

function resolveMove(constant) {
	if (!constant || constant === 'MOVE_NONE') return null;
	const move = dex.moves.get(toID(constant.replace(/^MOVE_/, '')));
	if (!move.exists) {
		warn(`unknown move ${constant}`);
		return null;
	}
	return move.name;
}

/** Held items must exist in the battle dex; anything else is a real problem. */
function resolveHeldItem(constant) {
	if (!constant || constant === 'ITEM_NONE') return '';
	const item = dex.items.get(toID(constant.replace(/^ITEM_/, '')));
	if (!item.exists) {
		// Nugget and Smoke Ball are real gen 3 held items with no battle effect
		// Showdown models, so they are absent from its dex by design.
		warn(`held item ${constant} has no Showdown equivalent; dropped`);
		return '';
	}
	return item.name;
}

/**
 * A trainer's `.items` are bag items the AI drinks mid-battle - Hyper Potions,
 * Full Restores. Showdown has no concept of either the bag or AI item use, so
 * these are recorded as readable names for later reference rather than looked
 * up in the held-item dex, where they correctly do not exist.
 */
function resolveBagItem(constant) {
	return titleCase(constant.replace(/^ITEM_/, '').replace(/_/g, ' '));
}

/** HIKER -> Hiker; {PKMN} TRAINER -> Pokemon Trainer. */
function titleCase(text) {
	return text
		.replace(/\{PKMN\}/g, 'Pokemon')
		.toLowerCase()
		.replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/** party symbol -> array of raw mon records */
function parseParties(source) {
	const parties = {};
	let current = null;
	let mon = null;

	const flush = () => {
		if (current && mon) parties[current].push(mon);
		mon = null;
	};

	for (const rawLine of source.split('\n')) {
		const line = rawLine.trim();

		const header = /^static const struct (\w+) (\w+)\[\]/.exec(line);
		if (header) {
			flush();
			current = header[2];
			parties[current] = [];
			continue;
		}
		if (!current) continue;

		// A new `.iv` starts a new mon; it is the first field of every variant.
		const iv = /^\.iv\s*=\s*(\d+)/.exec(line);
		if (iv) {
			flush();
			mon = { iv: Number(iv[1]) };
			continue;
		}
		if (!mon) continue;

		const lvl = /^\.lvl\s*=\s*(\d+)/.exec(line);
		if (lvl) { mon.lvl = Number(lvl[1]); continue; }

		const species = /^\.species\s*=\s*(\w+)/.exec(line);
		if (species) { mon.species = species[1]; continue; }

		const held = /^\.heldItem\s*=\s*(\w+)/.exec(line);
		if (held) { mon.heldItem = held[1]; continue; }

		const moves = /^\.moves\s*=\s*\{([^}]*)\}/.exec(line);
		if (moves) {
			mon.moves = moves[1].split(',').map(entry => entry.trim()).filter(Boolean);
			continue;
		}
	}
	flush();
	return parties;
}

/** TRAINER_X -> raw trainer record */
function parseTrainers(source) {
	const trainers = {};
	let current = null;

	for (const rawLine of source.split('\n')) {
		const line = rawLine.trim();

		const header = /^\[(TRAINER_\w+)\]\s*=/.exec(line);
		if (header) {
			current = header[1];
			trainers[current] = { id: current };
			continue;
		}
		if (!current) continue;

		const cls = /^\.trainerClass\s*=\s*(\w+)/.exec(line);
		if (cls) { trainers[current].trainerClass = cls[1]; continue; }

		const name = /^\.trainerName\s*=\s*_\("([^"]*)"\)/.exec(line);
		if (name) { trainers[current].name = name[1]; continue; }

		const double = /^\.doubleBattle\s*=\s*(\w+)/.exec(line);
		if (double) { trainers[current].doubleBattle = double[1] === 'TRUE'; continue; }

		const ai = /^\.aiFlags\s*=\s*(.+?),?$/.exec(line);
		if (ai) {
			trainers[current].ai = ai[1]
				.split('|')
				.map(flag => flag.trim().replace(/^AI_SCRIPT_/, ''))
				.filter(flag => flag && flag !== '0');
			continue;
		}

		const items = /^\.items\s*=\s*\{([^}]*)\}/.exec(line);
		if (items) {
			trainers[current].items = items[1]
				.split(',').map(entry => entry.trim()).filter(entry => entry && entry !== 'ITEM_NONE');
			continue;
		}

		const party = /^\.party\s*=\s*(\w+)\((\w+)\)/.exec(line);
		if (party) {
			trainers[current].partyMacro = party[1];
			trainers[current].partySymbol = party[2];
			continue;
		}
	}
	return trainers;
}

/** TRAINER_CLASS_X -> readable name */
function parseClassNames(source) {
	const names = {};
	const re = /\[(TRAINER_CLASS_\w+)\]\s*=\s*_\("([^"]*)"\)/g;
	let match;
	while ((match = re.exec(source))) names[match[1]] = titleCase(match[2]);
	return names;
}

/**
 * Which trainers stand on which map.
 *
 * Rematches are skipped: `trainerbattle_rematch` is the post-game Match Call
 * fight, not someone standing on the route the first time you walk it.
 */
function parseTrainerLocations() {
	const byLocation = {};
	const mapsDir = path.join(DECOMP, 'data/maps');

	for (const dir of fs.readdirSync(mapsDir)) {
		const file = path.join(mapsDir, dir, 'scripts.inc');
		if (!fs.existsSync(file)) continue;

		const source = fs.readFileSync(file, 'utf8');
		const re = /^\s*(trainerbattle\w*)\s+(.+)$/gm;
		let match;
		const found = [];
		while ((match = re.exec(source))) {
			if (/rematch/i.test(match[1])) continue;

			// The bare `trainerbattle` macro takes a battle TYPE first and the
			// trainer second: `trainerbattle TRAINER_BATTLE_CONTINUE_SCRIPT,
			// TRAINER_COLE, ...`. Every gym trainer is written this way, so
			// taking the first TRAINER_ token would drop all of them.
			const id = (match[2].match(/TRAINER_\w+/g) || [])
				.find(token => !token.startsWith('TRAINER_BATTLE_') && token !== 'TRAINER_NONE');
			if (!id) continue;
			if (!found.includes(id)) found.push(id);
		}
		if (!found.length) continue;

		// The map id is not in scripts.inc, but map.json next to it has it.
		const mapJson = path.join(mapsDir, dir, 'map.json');
		if (!fs.existsSync(mapJson)) continue;
		const mapId = JSON.parse(fs.readFileSync(mapJson, 'utf8')).id;
		let location = toCampaignId(mapId);

		// Where the campaign splits one ROM map in two, the ROM has no idea
		// which half a trainer stands on. Default them all to the first half -
		// the one you reach first - and let locations.json override the order
		// if a hand-tuned gauntlet reads better.
		if (SPLIT_MAPS[location]) {
			const [first] = SPLIT_MAPS[location];
			warn(`${location} is split in the campaign; assigning its ${found.length} trainer(s) to ${first}`);
			location = first;
		}

		byLocation[location] = (byLocation[location] || []).concat(
			found.filter(id => !(byLocation[location] || []).includes(id))
		);
	}
	return byLocation;
}

/* ------------------------------------------------------------------ *
 * Conversion
 * ------------------------------------------------------------------ */

const EMPTY_EVS = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };

function toSet(mon, macro) {
	const species = resolveSpecies(mon.species);
	if (!species) return null;

	const iv = ivFromByte(mon.iv);
	const usesCustomMoves = macro.includes('CUSTOM_MOVES');

	let moves;
	if (usesCustomMoves && mon.moves) {
		moves = mon.moves.map(resolveMove).filter(Boolean);
	} else {
		// "Default moves" means whatever it would know from levelling naturally.
		moves = levelUpMoveset(species.name, mon.lvl, MOD, 4).map(id => dex.moves.get(id).name);
	}
	if (!moves.length) moves = ['Tackle'];

	const abilities = Object.values(species.abilities).filter(Boolean);

	return {
		species: species.name,
		level: mon.lvl,
		// Gen 3 trainers roll no EVs, and one IV byte covers all six stats.
		ivs: { hp: iv, atk: iv, def: iv, spa: iv, spd: iv, spe: iv },
		evs: { ...EMPTY_EVS },
		item: macro.startsWith('ITEM_') ? resolveHeldItem(mon.heldItem) : '',
		ability: abilities[0] || '',
		// Nature and gender come from a personality value derived in-game; we
		// pin a neutral nature so battles are reproducible rather than trying
		// to reimplement that derivation.
		nature: 'Serious',
		moves,
	};
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

console.log(`Reading ${DECOMP}`);
const parties = parseParties(read('src/data/trainer_parties.h'));
const rawTrainers = parseTrainers(read('src/data/trainers.h'));
const classNames = parseClassNames(read('src/data/text/trainer_class_names.h'));
const byLocationRaw = parseTrainerLocations();

console.log(`  ${Object.keys(parties).length} parties`);
console.log(`  ${Object.keys(rawTrainers).length} trainer entries`);
console.log(`  ${Object.keys(classNames).length} trainer classes`);

const trainerKey = id => id.replace(/^TRAINER_/, '').toLowerCase();

const trainers = {};
let skipped = 0;
for (const [id, raw] of Object.entries(rawTrainers)) {
	if (id === 'TRAINER_NONE' || !raw.partySymbol) { skipped++; continue; }

	const party = parties[raw.partySymbol];
	if (!party || !party.length) {
		warn(`${id}: no party found for ${raw.partySymbol}`);
		skipped++;
		continue;
	}

	const team = party.map(mon => toSet(mon, raw.partyMacro)).filter(Boolean);
	if (!team.length) { skipped++; continue; }

	trainers[trainerKey(id)] = {
		name: titleCase(raw.name || 'Trainer'),
		trainerClass: classNames[raw.trainerClass] || titleCase(raw.trainerClass || 'Trainer'),
		doubleBattle: !!raw.doubleBattle,
		ai: raw.ai || [],
		items: (raw.items || []).map(resolveBagItem).filter(Boolean),
		team,
	};
}

// The campaign map is the authority on which places exist. Anything the ROM
// puts somewhere the campaign does not model - the Battle Frontier, interiors
// we never made votable - is set aside rather than indexed.
const locationsFile = path.join(PS_ROOT, 'data/campaigns/emerald/locations.json');
const campaignLocations = new Set(
	Object.keys(JSON.parse(fs.readFileSync(locationsFile, 'utf8'))).filter(id => !id.startsWith('_'))
);

const byLocation = {};
const offMap = {};
let placed = 0;
let orphaned = 0;
for (const [location, ids] of Object.entries(byLocationRaw)) {
	const keys = ids.map(trainerKey).filter(key => {
		if (trainers[key]) return true;
		orphaned++;
		warn(`${location}: no trainer built for "${key}"`);
		return false;
	});
	if (!keys.length) continue;

	if (campaignLocations.has(location)) {
		byLocation[location] = keys;
		placed += keys.length;
	} else {
		offMap[location] = keys.length;
	}
}

const output = {
	_comment: [
		'GENERATED by tools/campaigns/build-emerald-trainers.js - do not hand-edit.',
		'Source: pokeemerald src/data/trainers.h, trainer_parties.h, data/maps/*/scripts.inc.',
		'',
		'IVs: gen 3 stores one byte per trainer mon and applies it to all six stats',
		'(fixedIV = iv * 31 / 255, see CreateNPCTrainerParty in src/battle_main.c).',
		'EVs are always zero. Nature is pinned to Serious and ability to the first',
		'slot: in-game both come from a personality value we do not reproduce, and',
		'pinning them keeps battles reproducible.',
		'',
		'Default-moves trainers get the moves the species would know from levelling',
		'naturally, read from Showdown gen 3 learnsets.',
		'',
		'byLocation excludes rematches - those are post-game Match Call fights.',
	],
	trainers,
	byLocation,
};

fs.writeFileSync(OUT, `${JSON.stringify(output, null, '\t')}\n`);

console.log(`\nWrote ${path.relative(PS_ROOT, OUT)}`);
console.log(`  ${Object.keys(trainers).length} trainers built (${skipped} skipped)`);
console.log(`  ${placed} placements across ${Object.keys(byLocation).length} campaign locations`);
if (orphaned) console.log(`  ${orphaned} placement(s) dropped for missing trainers`);

const offMapTotal = Object.values(offMap).reduce((sum, n) => sum + n, 0);
if (offMapTotal) {
	const sample = Object.keys(offMap).sort().slice(0, 6).join(', ');
	console.log(`  ${offMapTotal} placement(s) in ${Object.keys(offMap).length} places the campaign ` +
		`does not model (${sample}${Object.keys(offMap).length > 6 ? ', ...' : ''})`);
}

const empty = [...campaignLocations].filter(id => !byLocation[id]).sort();
console.log(`  ${empty.length}/${campaignLocations.size} campaign locations have no trainers`);
if (warnings.length) {
	console.log(`\nWarnings:`);
	for (const line of warnings) console.log(`  ${line}`);
}
