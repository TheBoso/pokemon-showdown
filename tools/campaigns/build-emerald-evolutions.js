'use strict';
/**
 * Generates the evolution table for the Emerald campaign:
 *
 *   data/campaigns/emerald/evolutions.json
 *
 * Source:
 *   src/data/pokemon/evolution.h
 *
 * Showdown's own dex does carry evolution data, but it carries *current*
 * evolution data - later generations moved methods around, added ones gen 3
 * has no concept of, and changed levels. This run is Emerald, so the methods
 * come from Emerald.
 *
 * Every method the ROM has is emitted, including the ones nothing can trigger
 * yet: stones need a Poke Mart that sells them, trading needs trading, and
 * friendship and beauty need stats nobody tracks. Ripping them now costs
 * nothing and means those systems only have to be wired up, not researched.
 *
 * Usage:
 *   node tools/campaigns/build-emerald-evolutions.js [path-to-pokeemerald]
 */

const fs = require('fs');
const path = require('path');

const PS_ROOT = path.resolve(__dirname, '../..');
// The decomp is a sibling submodule of this one in the adventure repo.
const DECOMP = process.argv[2] || path.resolve(PS_ROOT, '../pokeemerald');

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
		console.error(`Pass the decomp path as an argument if it lives somewhere else.`);
		process.exit(2);
	}
	return fs.readFileSync(file, 'utf8');
}

function resolveSpecies(constant) {
	const species = dex.species.get(toID(constant.replace(/^SPECIES_/, '')));
	if (!species.exists) {
		warn(`unknown species ${constant}`);
		return null;
	}
	return species.name;
}

function resolveItem(constant) {
	// ITEM_THUNDER_STONE -> thunderstone, which is how Showdown ids every one
	// of the dozen items this table uses.
	const item = dex.items.get(toID(constant.replace(/^ITEM_/, '')));
	if (!item.exists) {
		warn(`unknown item ${constant}`);
		return null;
	}
	return item.id;
}

/**
 * The ROM's method constants, as this campaign names them.
 *
 * `param` says what the second field of the entry means, which differs per
 * method and is the only reason this cannot be a flat rename:
 *
 *   level   a level to reach       stone   an item to use
 *   none    the number is unused (trade, friendship)
 *   beauty  a beauty stat to reach
 */
const METHODS = {
	EVO_LEVEL: { kind: 'level', param: 'level' },
	EVO_ITEM: { kind: 'stone', param: 'stone' },
	EVO_TRADE: { kind: 'trade', param: 'none' },
	EVO_TRADE_ITEM: { kind: 'tradeHolding', param: 'stone' },
	EVO_FRIENDSHIP: { kind: 'friendship', param: 'none' },
	EVO_FRIENDSHIP_DAY: { kind: 'friendshipDay', param: 'none' },
	EVO_FRIENDSHIP_NIGHT: { kind: 'friendshipNight', param: 'none' },
	EVO_BEAUTY: { kind: 'beauty', param: 'beauty' },
	// Wurmple splits on a personality value the ROM rolls when it is generated.
	EVO_LEVEL_SILCOON: { kind: 'levelSilcoon', param: 'level' },
	EVO_LEVEL_CASCOON: { kind: 'levelCascoon', param: 'level' },
	// Nincada does both at once: it evolves into Ninjask and *also* leaves a
	// Shedinja behind, if there is a spare party slot and a spare Poke Ball.
	EVO_LEVEL_NINJASK: { kind: 'levelNinjask', param: 'level' },
	EVO_LEVEL_SHEDINJA: { kind: 'levelShedinja', param: 'level' },
	// Tyrogue, which splits on its own Attack and Defense.
	EVO_LEVEL_ATK_GT_DEF: { kind: 'levelAtkGtDef', param: 'level' },
	EVO_LEVEL_ATK_LT_DEF: { kind: 'levelAtkLtDef', param: 'level' },
	EVO_LEVEL_ATK_EQ_DEF: { kind: 'levelAtkEqDef', param: 'level' },
};

function build() {
	const source = read('src/data/pokemon/evolution.h');
	const evolutions = {};
	let entries = 0;

	// [SPECIES_X] = {{METHOD, param, SPECIES_Y}, {METHOD, param, SPECIES_Z}},
	// Entries wrap across lines, so the body is matched as one blob and the
	// individual `{...}` triples picked out of it afterwards.
	const perSpecies = /\[(SPECIES_\w+)\]\s*=\s*\{([\s\S]*?)\}\s*,\s*(?=\[SPECIES_|\};)/g;

	let match;
	while ((match = perSpecies.exec(source))) {
		const from = resolveSpecies(match[1]);
		if (!from) continue;

		const list = [];
		const triple = /\{\s*(EVO_\w+)\s*,\s*([\w]+)\s*,\s*(SPECIES_\w+)\s*\}/g;
		let evo;
		while ((evo = triple.exec(match[2]))) {
			const [, methodConstant, rawParam, intoConstant] = evo;

			const method = METHODS[methodConstant];
			if (!method) {
				warn(`unknown method ${methodConstant} on ${match[1]}`);
				continue;
			}
			const into = resolveSpecies(intoConstant);
			if (!into) continue;

			const entry = { kind: method.kind, into };
			if (method.param === 'level') entry.level = Number(rawParam);
			if (method.param === 'beauty') entry.beauty = Number(rawParam);
			if (method.param === 'stone') {
				const stone = resolveItem(rawParam);
				if (!stone) continue;
				entry.stone = stone;
			}
			list.push(entry);
			entries++;
		}

		if (list.length) evolutions[toID(from)] = list;
	}

	return { evolutions, entries };
}

const { evolutions, entries } = build();

const out = {
	_comment: [
		`GENERATED by tools/campaigns/build-emerald-evolutions.js - do not hand-edit.`,
		`Source: pokeemerald src/data/pokemon/evolution.h.`,
		``,
		`Keyed by the species that evolves. Each entry says how, and into what.`,
		`Kinds nothing can trigger yet - stone, trade, friendship, beauty - are`,
		`ripped anyway so the systems that gate them only have to be wired up.`,
	],
	evolutions,
};

const target = path.join(PS_ROOT, 'data/campaigns/emerald/evolutions.json');
fs.writeFileSync(target, JSON.stringify(out, null, '\t') + '\n');

console.log(`Wrote ${Object.keys(evolutions).length} evolving species (${entries} evolutions) to`);
console.log(`  ${path.relative(PS_ROOT, target)}`);

const kinds = {};
for (const list of Object.values(evolutions)) {
	for (const entry of list) kinds[entry.kind] = (kinds[entry.kind] || 0) + 1;
}
console.log(`\nBy method:`);
for (const [kind, count] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
	console.log(`  ${kind.padEnd(16)} ${count}`);
}

if (warnings.length) {
	console.log(`\n${warnings.length} warning(s):`);
	for (const message of warnings) console.log(`  ${message}`);
}
