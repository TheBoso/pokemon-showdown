'use strict';
/**
 * Mapping pokeemerald map ids onto campaign location ids.
 *
 * Shared by verify-emerald-map.js and build-emerald-trainers.js so the two
 * cannot drift: a trainer assigned to a location the verifier does not
 * recognise would be silently unreachable.
 */

/**
 * Interiors the ROM splits across many maps that are one place to a player.
 * Longest prefix wins, so MAP_MT_PYRE_SUMMIT resolves before MAP_MT_PYRE_1F.
 */
const COLLAPSE = {
	MAP_GRANITE_CAVE: 'granitecave',
	MAP_METEOR_FALLS: 'meteorfalls',
	MAP_MT_PYRE: 'mtpyre',
	MAP_SHOAL_CAVE: 'shoalcave',
	MAP_SEAFLOOR_CAVERN: 'seafloorcavern',
	MAP_VICTORY_ROAD: 'victoryroad',
	MAP_SKY_PILLAR: 'skypillar',
	MAP_CAVE_OF_ORIGIN: 'caveoforigin',
	MAP_AQUA_HIDEOUT: 'aquahideout',
	MAP_MAGMA_HIDEOUT: 'magmahideout',
	MAP_RUSTURF_TUNNEL: 'rusturftunnel',
	MAP_PETALBURG_WOODS: 'petalburgwoods',
	MAP_FIERY_PATH: 'fierypath',
	MAP_JAGGED_PASS: 'jaggedpass',
	MAP_MT_CHIMNEY: 'mtchimney',
	MAP_EVER_GRANDE_CITY_POKEMON_LEAGUE: 'pokemonleague',
	// The Elite Four and Champion each have their own room map. They are one
	// gauntlet to the player, and one location on the campaign map.
	MAP_EVER_GRANDE_CITY_SIDNEYS_ROOM: 'pokemonleague',
	MAP_EVER_GRANDE_CITY_PHOEBES_ROOM: 'pokemonleague',
	MAP_EVER_GRANDE_CITY_GLACIAS_ROOM: 'pokemonleague',
	MAP_EVER_GRANDE_CITY_DRAKES_ROOM: 'pokemonleague',
	MAP_EVER_GRANDE_CITY_CHAMPIONS_ROOM: 'pokemonleague',
};

/** Campaign ids that intentionally cover one decomp map between them. */
const SPLIT_MAPS = { route104: ['route104south', 'route104north'] };

/**
 * Gyms live inside their city on the campaign map, so a gym map resolves to
 * the city that holds it rather than to a location of its own.
 */
const GYM_SUFFIX = /_GYM(_.*)?$/;

function toCampaignId(mapId) {
	for (const prefix of Object.keys(COLLAPSE).sort((a, b) => b.length - a.length)) {
		if (mapId === prefix || mapId.startsWith(`${prefix}_`)) return COLLAPSE[prefix];
	}
	let id = mapId.replace(/^MAP_/, '');
	id = id.replace(GYM_SUFFIX, '');
	id = id.toLowerCase().replace(/_/g, '');
	id = id.replace(/(town|city)$/, '');
	return id;
}

module.exports = { COLLAPSE, SPLIT_MAPS, toCampaignId };
