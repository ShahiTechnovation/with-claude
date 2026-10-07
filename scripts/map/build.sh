#!/bin/sh
# Rebuilds src/data/india-map.ts (the India outline, islands and state lines for CityAtlas)
# from DataMeet's state boundaries.
#
# usage: MAP_SRC=<folder> sh scripts/map/build.sh [simplify-interval-metres]
#
# MAP_SRC holds Admin2.shp, .shx, .dbf, .prj, .cpg and india-composite.geojson, from
#   https://github.com/datameet/maps/tree/master/States   (Admin2.*, CC BY 2.5 IN:
#     https://creativecommons.org/licenses/by/2.5/in/, credited on /about/)
#   https://github.com/datameet/maps/tree/master/Country  (india-composite.geojson, CC0)
# The sources (about 28 MB) never enter git.
#
# City positions are not in the output: CityAtlas places them from src/data/cities.ts
# with projectIndia() in src/lib/geo.ts, which uses the same frame as this build.
set -eu
: "${MAP_SRC:?set MAP_SRC to a folder with Admin2.shp, .shx, .dbf, .prj, .cpg and india-composite.geojson}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
INTERVAL="${1:-1600}"
P='+proj=lcc +lat_1=12 +lat_2=28 +lat_0=22 +lon_0=80 +datum=WGS84 +units=m +no_defs'
ISLES='ST_NM == "Andaman & Nicobar" || ST_NM == "Lakshadweep"'

# One -proj call and one SVG export for every layer, so outline, islands and state lines
# share a single transform.
# Admin2 lacks two Andaman & Nicobar islands, Barren and Narcondam. They are taken from
# DataMeet's CC0 india-composite.geojson, where they are the only parts east of 93.5E
# between 12N and 14.5N. (Its other islands sit a few km off Admin2's, so an overlap
# test would add them twice: Chowra did, in v1.)
# Islands are filtered before -proj so min-area is true (spherical) area: LCC shrinks
# areas by up to 2% near 20N, which would drop 2.0x km2 Sundarbans islands.
# Lakshadweep's atolls are under 2 km2, so it keeps parts over 0.25 km2 instead.
# Every part is exploded into its own feature before -simplify: keep-shapes keeps
# one ring per feature, so this is what keeps every island.
# probes: one interior point per part, which post.mjs uses to check none was lost.
# raw.svg keeps 0.001 units; post.mjs snaps to 0.1 except where that makes rings cross.
npx -y mapshaper@0.7.80 -i "$MAP_SRC/Admin2.shp" "$MAP_SRC/india-composite.geojson" combine-files \
  -rename-layers states,extra \
  -explode target=extra \
  -filter 'this.bounds[0] > 93.5 && this.bounds[1] > 12 && this.bounds[3] < 14.5' target=extra \
  -each 'ST_NM = "Andaman & Nicobar"' target=extra \
  -merge-layers target=states,extra name=states force \
  -clean target=states \
  -filter 'ST_NM == "Lakshadweep"' + name=lak target=states \
  -filter 'ST_NM != "Lakshadweep"' target=states \
  -filter-islands min-area=2e6 target=states \
  -explode target=lak \
  -filter 'this.area > 250000' target=lak \
  -merge-layers target=states,lak name=states \
  -explode target=states \
  -points inner + name=probes target=states \
  -proj "$P" target=states,probes \
  -style r=1 target=probes \
  -simplify variable interval="ST_NM == 'Lakshadweep' ? 300 : $INTERVAL" keep-shapes target=states \
  -filter 'this.area > 0' target=states \
  -dissolve ST_NM target=states \
  -filter "$ISLES" + name=islands target=states \
  -filter "!($ISLES)" + name=india target=states \
  -dissolve target=india \
  -innerlines target=states \
  -o "$TMP/raw.svg" format=svg width=1040 margin=0 svg-bbox=-1268500,-1685500,1773500,1754300 precision=0.001 target=india,islands,states,probes

node "$REPO/scripts/map/post.mjs" "$TMP/raw.svg" "$REPO/src/data/india-map.ts"
