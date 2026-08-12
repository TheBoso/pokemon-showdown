'use strict';
/**
 * Diffs data/campaigns/emerald/locations.json against the pokeemerald decomp.
 *
 * The campaign map is hand-curated on purpose - it encodes the shape of a
 * playthrough, not the shape of the ROM, and it deliberately collapses things
 * the ROM splits (Granite Cave's four floors are one place to vote about) and
 * splits things the ROM joins (Route 104's two halves, either side of the
 * woods). So this does not generate the map; it checks the adjacencies in it
 * against the real ones and reports where they disagree.
 *
 * That distinction matters: the structural validator in campaigns.ts proves the
 * graph is well-formed, which a completely wrong map can also be. This is the
 * check that it matches Hoenn.
 *
 * Usage:
 *   node tools/campaigns/verify-emerald-map.js [path-to-pokeemerald]
 */

const fs = require('fs');
const path = require('path');

const DECOMP = process.argv[2] || 'D:/Projects/Personal/PokemonThing/pokeemerald';
const CAMPAIGN = path.resolve(__dirname, '../../data/campaigns/emerald/locations.json');

/* ------------------------------------------------------------------ *
 * Mapping decomp map ids onto campaign location ids
 * ------------------------------------------------------------------ */

const { SPLIT_MAPS, toCampaignId } = require('./emerald-maps');

/**
 * Links the ROM's `connections`/`warp_events` cannot express, with the reason
 * each is real anyway. Anything not listed here that fails to match is a bug in
 * the campaign map, so this list stays short and justified.
 */
const ACCEPTED = {
	'dewford|route104south': `Mr. Briney's ferry - a script, not a map edge`,
	'mtchimney|route112': `the cable car, which runs via its own station maps`,
	'route126|sootopolis': `Dive into the crater; dive/emerge edges are skipped`,
	'route128|seafloorcavern': `Dive entrance; dive/emerge edges are skipped`,
	'pokemonleague|victoryroad': `deliberate: the ROM exits Victory Road into Ever Grande's north half, ` +
		`which we collapse into one city, and routing the League behind Victory Road is the point`,
};

function acceptedReason(a, b) {
	return ACCEPTED[[a, b].sort().join('|')];
}

/* ------------------------------------------------------------------ *
 * Reading the decomp
 * ------------------------------------------------------------------ */

const mapsDir = path.join(DECOMP, 'data/maps');
if (!fs.existsSync(mapsDir)) {
	console.error(`No decomp at ${DECOMP} (looked for data/maps).`);
	console.error(`Pass the path: node tools/campaigns/verify-emerald-map.js <path-to-pokeemerald>`);
	process.exit(2);
}

/** campaignId -> Set(campaignId) built from real overworld adjacency. */
const realGraph = new Map();
/** campaignId -> Set(campaignId) built from warps (doors, cave mouths). */
const warpGraph = new Map();
const knownMaps = new Set();

function link(graph, a, b) {
	if (!a || !b || a === b) return;
	if (!graph.has(a)) graph.set(a, new Set());
	graph.get(a).add(b);
}

for (const dir of fs.readdirSync(mapsDir)) {
	const file = path.join(mapsDir, dir, 'map.json');
	if (!fs.existsSync(file)) continue;

	let map;
	try {
		map = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (err) {
		console.error(`  skipping ${dir}: ${err.message}`);
		continue;
	}

	const from = toCampaignId(map.id);
	knownMaps.add(from);

	// `connections` is true overworld adjacency: walking off one edge onto another.
	for (const connection of map.connections || []) {
		// dive/emerge are vertical, not travel between places you vote about
		if (['dive', 'emerge'].includes(connection.direction)) continue;
		link(realGraph, from, toCampaignId(connection.map));
	}

	// Warps are doors. Noisy (every building), but they are the only way
	// interiors attach to the overworld.
	for (const warp of map.warp_events || []) {
		if (!warp.dest_map) continue;
		link(warpGraph, from, toCampaignId(warp.dest_map));
	}
}

/* ------------------------------------------------------------------ *
 * Reading the campaign map
 * ------------------------------------------------------------------ */

const raw = JSON.parse(fs.readFileSync(CAMPAIGN, 'utf8'));
const campaign = {};
for (const [id, location] of Object.entries(raw)) {
	if (!id.startsWith('_')) campaign[id] = location;
}

const campaignGraph = new Map();
for (const [id, location] of Object.entries(campaign)) {
	for (const entry of location.connections || []) {
		link(campaignGraph, id, typeof entry === 'string' ? entry : entry.to);
	}
}

/** Every id the decomp could legitimately produce for a campaign location. */
function decompAliases(campaignId) {
	for (const [mapId, halves] of Object.entries(SPLIT_MAPS)) {
		if (halves.includes(campaignId)) return new Set([mapId, ...halves]);
	}
	return new Set([campaignId]);
}

/** Real adjacency for a campaign id, merged across warps and split halves. */
function realNeighbours(campaignId) {
	const out = new Set();
	for (const alias of decompAliases(campaignId)) {
		for (const n of realGraph.get(alias) || []) out.add(n);
		for (const n of warpGraph.get(alias) || []) out.add(n);
	}
	// A split map's halves are adjacent to each other by construction.
	for (const halves of Object.values(SPLIT_MAPS)) {
		if (halves.includes(campaignId)) for (const h of halves) out.add(h);
	}
	out.delete(campaignId);
	return out;
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

let unconfirmed = 0;
let missing = 0;

console.log(`\nDecomp: ${DECOMP}`);
console.log(`Campaign locations: ${Object.keys(campaign).length}`);
console.log(`Decomp maps collapsed to: ${knownMaps.size} ids\n`);

console.log(`== campaign locations with no matching decomp map ==`);
const unknown = Object.keys(campaign).filter(id => {
	for (const alias of decompAliases(id)) if (knownMaps.has(alias)) return false;
	return true;
});
console.log(unknown.length ? `  ${unknown.join(', ')}` : `  (none - every location exists in the ROM)`);

console.log(`== connections in the campaign map the ROM does not support ==`);
const acceptedSeen = new Set();
for (const [id, targets] of [...campaignGraph].sort()) {
	const real = realNeighbours(id);
	const bogus = [...targets].filter(target => {
		if (real.has(target)) return false;
		// Accept if the reverse direction confirms it; the ROM records
		// adjacency on whichever side owns the edge.
		if (realNeighbours(target).has(id)) return false;
		const reason = acceptedReason(id, target);
		if (reason) {
			acceptedSeen.add(`${[id, target].sort().join(' <-> ')}: ${reason}`);
			return false;
		}
		return true;
	});
	if (bogus.length) {
		unconfirmed += bogus.length;
		console.log(`  ${id} -> ${bogus.join(', ')}`);
	}
}
if (!unconfirmed) console.log(`  (none)`);

console.log(`\n== accepted as scripted or deliberate ==`);
for (const line of [...acceptedSeen].sort()) console.log(`  ${line}`);

console.log(`\n== real adjacencies between campaign locations that the map omits ==`);
console.log(`   (expected: the map deliberately prunes side doors and dead ends)`);
for (const id of Object.keys(campaign).sort()) {
	const declared = campaignGraph.get(id) || new Set();
	const absent = [...realNeighbours(id)]
		.filter(target => campaign[target] && !declared.has(target));
	if (absent.length) {
		missing += absent.length;
		console.log(`  ${id} is really adjacent to: ${absent.join(', ')}`);
	}
}
if (!missing) console.log(`  (none)`);

console.log(`\n${unconfirmed} unsupported connection(s), ${missing} omitted adjacency(ies)\n`);
process.exit(unconfirmed ? 1 : 0);
