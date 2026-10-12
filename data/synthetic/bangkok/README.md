# Bangkok flood demo data (FL-69)

The UC-4 demo uses a static public OpenStreetMap base map and simulated flood
records. Files are committed so the demo, seed loader and CI run offline.

## Public base map (FL-136)

- `canals.geojson`: 168 complete OSM canal ways intersecting the query box
  south/west/north/east `13.74,100.56,13.81,100.65`. Ways are not clipped; their
  ends can extend outside the box. This is a local extract, not all Bangkok canals.
- `districts.geojson`: full OSM boundaries of Huai Khwang District (relation
  `2938032`) and Bang Kapi District (`2939952`). Administrative boundaries are
  reference geometry, not verified drainage catchments or flood forecasts.
- `sources/`: normalized source snapshots, download URLs/query, retrieval time,
  source timestamps and SHA-256 hashes. Geometry/node IDs and relevant names are
  retained; contributor identities, population figures and unrelated tags are
  omitted. The canal snapshot reports `2026-06-01T08:52:28Z` as its OSM base
  timestamp. It is not claimed to be current or complete.

Rebuild from the saved, hash-checked snapshots without network access:

```sh
node data/synthetic/bangkok/extract.mjs
node data/synthetic/bangkok/extract.mjs --output-dir /tmp/bangkok-extract
```

An explicit `--refresh` downloads all sources, validates the geometry and then
replaces the snapshots and outputs. Review the changed source dates, hashes and
geometry before committing; it is never run during the demo or CI. Overpass
availability varies. The district boundaries use the OSM API directly because
the Overpass endpoint was unavailable for those relations during authoring.

## Licence and attribution

Map data © OpenStreetMap contributors, licensed under the
[Open Data Commons Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
See [OSM copyright and licence](https://www.openstreetmap.org/copyright).
The normalized snapshots and derived canal/district GeoJSON are provided under
ODbL-1.0. Keep attribution and licence metadata with exports; map consumers must
display **© OpenStreetMap contributors** linked to the OSM copyright page.
The source data is available in `sources/` for redistribution/reproduction.

These source features carry `simulated=false`, `classification=PUBLIC` and
`PUBLIC BASE MAP`. Future flood Health, Signals and artificial Facility locations
must carry SIMULATION/SYNTHETIC labels independently of this public geometry.

## Simulated Assets (FL-137)

`zones.geojson` uses the two district footprints as illustrative Area Assets:
Z3 (Huai Khwang) and Z4 (Bang Kapi). Both carry `SIMULATION`; no drainage
connectivity or catchment delineation is asserted. OSM attribution stays on the
derived geometry.

`facilities.geojson` contains three pumps (P-1/P-2/P-3), two gates (G-1/G-2),
and rain, level and tide sensors (S-R1/S-L1/S-T1). All positions are authored,
labelled `SYNTHETIC`, with `simulated=true` and `HIGHLY_RESTRICTED`. The tide
sensor is a mock source target, not a claim that a real tide gauge exists there.
P-3 is reserved for the simulated pump-power-loss storyline. The generator
checks that each Point falls within its assigned zone.

```sh
node data/synthetic/bangkok/generate.mjs
```

## Bowtie D (FL-138)

`bowtie-d.json` authors PRD §6.1-D: four Threats, four Consequences (severity
5/5/4/4), ten Preventive and five Mitigative Barriers, eight complete paths,
Validation Triad justifications, one shared-response-team Independence Group,
four Degradation Factors with Controls and two simulated Evidence records per
Barrier. The initial generator-backup Barrier is Degraded with its monthly test
overdue at the fixed simulation start, `2026-10-12T00:00:00Z`.

Frequency/PFD/conditional-probability parameters are illustrative simulation
inputs with `parameterBasis`; no measured operating rates or forecasts are
claimed. Physical response functions are modelled only: de-energising substations
and deploying pumps require human-operated L1 Command Packages. Early warning
requires the separate approval-gated sandbox notification feature.

The database loader in [db/seed/bangkok](../../../db/seed/bangkok/README.md)
loads Area/Linear/Facility Assets, this graph and Evidence Geo References in one
transaction. All database records exercise the demo classification/Simulation
rules; raw public OSM files retain their independent public metadata.

```sh
FIELDLOOP_ORG_ID=fieldloop-demo node db/seed/bangkok/seed.mjs --print-sql
pnpm test:seed:bangkok
```
