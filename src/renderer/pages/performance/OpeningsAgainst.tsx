import "./OpeningsAgainst.css";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "../../components/ui/Card";
import { Pill, PillRow } from "../../components/ui/Pill";
import { useOpeningsAgainst } from "../../hooks/queries";
import type { OpeningsAgainstFilters, OpeningsAgainstResult } from "../../../openingsAgainst";
import { EVENT_SAMPLE_GUARDS, OPENING_SITUATION_ORDER } from "../../../characterEventProfile";
import { OPENING_PERCENT_BANDS, type OpeningPercentBand } from "../../../openingPercentBands";
import { pct, prettyLabel, ratio } from "../characters/shared";

type OpeningBucket = OpeningsAgainstResult["buckets"][number];
type OpeningExample = OpeningsAgainstResult["examples"][number];
type SequenceGroup = Extract<OpeningsAgainstResult["clusters"], { status: "ok" }>["groups"][number];
type SequenceCluster = SequenceGroup["clusters"][number];

const RECENCY_OPTIONS = [50, 100, 200, 500] as const;
const SITUATION_RANK = new Map(OPENING_SITUATION_ORDER.map((key, index) => [key, index]));

function situationRank(situation: string): number {
  return SITUATION_RANK.get(situation as (typeof OPENING_SITUATION_ORDER)[number]) ?? OPENING_SITUATION_ORDER.length;
}

function sortBuckets(buckets: OpeningBucket[], by: "count" | "kills"): OpeningBucket[] {
  return [...buckets].sort((a, b) => {
    if (by === "kills" && b.kills !== a.kills) return b.kills - a.kills;
    if (b.count !== a.count) return b.count - a.count;
    if (b.kills !== a.kills) return b.kills - a.kills;
    return a.openerLabel.localeCompare(b.openerLabel);
  });
}

function PercentBandChart({ bands }: { bands: OpeningPercentBand[] }) {
  return (
    <div className="openings-bands">
      {bands.map((band) => (
        <div
          key={band.key}
          className="openings-band"
          title={`${band.count} opening${band.count === 1 ? "" : "s"} · ${band.kills} kill${band.kills === 1 ? "" : "s"}`}
        >
          <span>{band.label}</span>
          <span className="mono">
            {band.count}
            {band.kills > 0 ? ` · ${band.kills}K` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

interface SituationSection {
  situation: string;
  total: number;
  buckets: OpeningBucket[];
}

function groupBySituation(buckets: OpeningBucket[]): SituationSection[] {
  const groups = new Map<string, OpeningBucket[]>();
  for (const bucket of buckets) {
    const list = groups.get(bucket.situation) ?? [];
    list.push(bucket);
    groups.set(bucket.situation, list);
  }
  return [...groups.entries()]
    .sort((a, b) => situationRank(a[0]) - situationRank(b[0]) || a[0].localeCompare(b[0]))
    .map(([situation, rows]) => ({
      situation,
      total: rows.reduce((sum, row) => sum + row.count, 0),
      buckets: rows,
    }));
}

function ExampleChip({ example, onOpen }: { example: OpeningExample; onOpen: () => void }) {
  if (example.gameId == null) return null;
  return (
    <button
      type="button"
      className={`openings-example-chip${example.didKill ? " openings-example-kill" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      title={`${example.openerLabel} at ${example.victimPercent}% — ${
        example.didKill ? "this conversion took the stock" : "no kill"
      }`}
    >
      <span className="mono">{example.timestamp}</span>
      <span>{example.victimPercent}%</span>
      {example.didKill && <span className="openings-example-kill-dot" aria-label="kill" />}
    </button>
  );
}

function BucketRow({
  bucket,
  situationTotal,
  dimmed,
  expanded,
  onToggle,
  onOpenExample,
}: {
  bucket: OpeningBucket;
  situationTotal: number;
  dimmed: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpenExample: (example: OpeningExample) => void;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className={`openings-bucket${dimmed ? " openings-bucket-dim" : ""}`}>
      <button
        type="button"
        className="openings-bucket-row"
        onClick={onToggle}
        aria-expanded={expanded}
        title={
          dimmed
            ? `Only ${bucket.count} example${bucket.count === 1 ? "" : "s"} — collect more games before reading this as a habit`
            : `${bucket.openerLabel}: ${bucket.count} of ${situationTotal} openings in this situation`
        }
      >
        <Chevron size={12} className="openings-bucket-chevron" aria-hidden="true" />
        <span className="openings-bucket-label">
          <span>{prettyLabel(bucket.openerLabel)}</span>
          <span className={`openings-family-tag openings-family-${bucket.openerFamily}`}>
            {prettyLabel(bucket.openerFamily)}
          </span>
        </span>
        <span className="openings-bar-track">
          <span
            className="openings-bar-fill"
            style={{ width: `${Math.min(100, (bucket.count / situationTotal) * 100)}%` }}
          />
        </span>
        <span className="openings-bucket-share">
          {pct(bucket.count, situationTotal)}{" "}
          <span className="openings-ratio">{ratio(bucket.count, situationTotal)}</span>
        </span>
        <span
          className="openings-bucket-kill"
          title={`${bucket.kills} kill${bucket.kills === 1 ? "" : "s"} off this opening`}
        >
          {pct(bucket.kills, bucket.count)} <span className="openings-ratio">{ratio(bucket.kills, bucket.count)}</span>
        </span>
      </button>

      {expanded && (
        <div className="openings-bucket-details">
          <div className="openings-detail-grid">
            <div className="openings-detail-block">
              <span className="openings-detail-heading">Victim percent at the first hit</span>
              <PercentBandChart bands={bucket.splits.percentBands} />
            </div>
            <div className="openings-detail-block">
              <span className="openings-detail-heading">Qualifiers</span>
              <div className="openings-qualifiers">
                <span>
                  Cornered{" "}
                  <strong className="mono">
                    {bucket.corneredShare > 0 ? `${Math.round(bucket.corneredShare * 100)}%` : "—"}
                  </strong>
                </span>
                <span>
                  On platform{" "}
                  <strong className="mono">
                    {bucket.onPlatformShare > 0 ? `${Math.round(bucket.onPlatformShare * 100)}%` : "—"}
                  </strong>
                </span>
                <span>
                  Avg damage <strong className="mono">{bucket.avgDamage.toFixed(1)}</strong>
                </span>
                <span>
                  Follow-up hits <strong className="mono">{bucket.avgFollowUpHits.toFixed(1)}</strong>
                </span>
                <span>
                  Games <strong className="mono">{bucket.distinctGames}</strong>
                </span>
              </div>
            </div>
          </div>
          <div className="openings-example-row">
            <span className="openings-example-label">Examples</span>
            {bucket.examples.length > 0 ? (
              bucket.examples.map((example) => (
                <ExampleChip
                  key={`${example.gameId}-${example.startFrame}`}
                  example={example}
                  onOpen={() => onOpenExample(example)}
                />
              ))
            ) : (
              <span className="openings-example-empty">No navigable examples</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SequenceClusterRow({
  cluster,
  groupWithSequence,
  dimmed,
  expanded,
  onToggle,
  onOpenExample,
}: {
  cluster: SequenceCluster;
  groupWithSequence: number;
  dimmed: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpenExample: (example: OpeningExample) => void;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className={`openings-bucket${dimmed ? " openings-bucket-dim" : ""}`}>
      <button
        type="button"
        className="openings-bucket-row"
        onClick={onToggle}
        aria-expanded={expanded}
        title={
          dimmed
            ? `${cluster.label}: ${cluster.size} openings — collect more games before reading this as a habit`
            : `${cluster.label}: ${cluster.size} of ${groupWithSequence} openings with a recorded move list`
        }
      >
        <Chevron size={12} className="openings-bucket-chevron" aria-hidden="true" />
        <span className="openings-bucket-label">
          <span>{cluster.label}</span>
          {cluster.kind === "tail" && <span className="openings-family-tag">{cluster.variants} seq</span>}
          <span className={`openings-family-tag openings-family-${cluster.dominantFamily}`}>
            {prettyLabel(cluster.dominantFamily)}
          </span>
        </span>
        <span className="openings-bar-track">
          <span className="openings-bar-fill" style={{ width: `${Math.min(100, cluster.share * 100)}%` }} />
        </span>
        <span className="openings-bucket-share">
          {pct(cluster.size, groupWithSequence)}{" "}
          <span className="openings-ratio">{ratio(cluster.size, groupWithSequence)}</span>
        </span>
        <span
          className="openings-bucket-kill"
          title={`${cluster.kills} kill${cluster.kills === 1 ? "" : "s"} off this sequence`}
        >
          {pct(cluster.kills, cluster.size)}{" "}
          <span className="openings-ratio">{ratio(cluster.kills, cluster.size)}</span>
        </span>
      </button>

      {expanded && (
        <div className="openings-bucket-details">
          <div className="openings-detail-grid">
            <div className="openings-detail-block">
              <span className="openings-detail-heading">Victim percent at the first hit</span>
              <PercentBandChart bands={cluster.percentBands} />
            </div>
            <div className="openings-detail-block">
              <span className="openings-detail-heading">Qualifiers</span>
              <div className="openings-qualifiers">
                <span>
                  Victim percent <strong className="mono">{Math.round(cluster.percentMean)}% avg</strong>{" "}
                  <span className="mono">
                    ({Math.round(cluster.percentP25)}–{Math.round(cluster.percentP75)}% middle half,{" "}
                    {Math.round(cluster.percentMedian)}% median)
                  </span>
                </span>
                <span>
                  Cornered <strong className="mono">{Math.round(cluster.corneredShare * 100)}%</strong>
                </span>
                <span>
                  On platform <strong className="mono">{Math.round(cluster.onPlatformShare * 100)}%</strong>
                </span>
                <span>
                  Avg damage <strong className="mono">{cluster.avgDamage.toFixed(1)}</strong>
                </span>
                <span>
                  Avg hits <strong className="mono">{cluster.avgMoveCount.toFixed(1)}</strong>
                </span>
                <span>
                  Games <strong className="mono">{cluster.distinctGames}</strong>
                </span>
                {cluster.kind === "tail" && (
                  <span>
                    Distinct sequences <strong className="mono">{cluster.variants}</strong>
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="openings-example-row">
            <span className="openings-example-label">Examples</span>
            {cluster.examples.length > 0 ? (
              cluster.examples.map((example) => (
                <ExampleChip
                  key={`${example.gameId}-${example.startFrame}`}
                  example={example}
                  onOpen={() => onOpenExample(example)}
                />
              ))
            ) : (
              <span className="openings-example-empty">No navigable examples</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function OpeningsAgainst() {
  const navigate = useNavigate();
  const [character, setCharacter] = useState("all");
  const [opponentCharacter, setOpponentCharacter] = useState("all");
  const [stage, setStage] = useState("all");
  const [percentBand, setPercentBand] = useState("all");
  const [limit, setLimit] = useState<number>(200);
  const [sort, setSort] = useState<"count" | "kills">("count");
  const [expanded, setExpanded] = useState<string | null>(null);

  const queryFilters = useMemo(() => {
    const filters: OpeningsAgainstFilters = { limit };
    if (character !== "all") filters.character = character;
    if (opponentCharacter !== "all") filters.opponentCharacter = opponentCharacter;
    if (stage !== "all") filters.stage = stage;
    if (percentBand !== "all") filters.percentBand = percentBand;
    return filters;
  }, [character, opponentCharacter, stage, percentBand, limit]);

  const { data, isLoading, isError } = useOpeningsAgainst(queryFilters);
  const openExample = (example: OpeningExample) => {
    if (example.gameId == null) return;
    navigate(`/game/${example.gameId}`, { state: { seekFrame: example.startFrame } });
  };

  const buckets = useMemo(() => (data ? sortBuckets(data.buckets, sort) : []), [data, sort]);
  const sections = useMemo(() => groupBySituation(buckets), [buckets]);
  const lowOverallSample = data != null && data.baseline.total < EVENT_SAMPLE_GUARDS.openingsTotalMin;
  const missingGames = data ? Math.max(0, data.coverage.gamesInScope - data.coverage.gamesParsedCurrent) : 0;

  return (
    <section aria-labelledby="openings-heading">
      <div className="performance-section-heading">
        <div>
          <span className="performance-eyebrow">Neutral defense</span>
          <h2 id="openings-heading">Openings against you</h2>
        </div>
        <span className="performance-data-note">First hit in neutral · rule buckets, not guesses</span>
      </div>

      <Card className="openings-against">
        <p className="openings-intro">
          The first hit in neutral of each opponent conversion where you were the victim. Grabs are recorded at the grab
          frame, not the throw. Combo follow-ups, ledge/offstage hits, and situations already covered by the habit and
          recovery ledgers are excluded.
        </p>

        <div className="openings-filters">
          <label>
            <span className="tweaks-label">Your character</span>
            <select
              className="library-filter-input"
              value={character}
              onChange={(event) => setCharacter(event.target.value)}
            >
              <option value="all">All characters</option>
              {(data?.options.characters ?? []).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="tweaks-label">Opponent character</span>
            <select
              className="library-filter-input"
              value={opponentCharacter}
              onChange={(event) => setOpponentCharacter(event.target.value)}
            >
              <option value="all">All opponents</option>
              {(data?.options.opponentCharacters ?? []).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="tweaks-label">Stage</span>
            <select className="library-filter-input" value={stage} onChange={(event) => setStage(event.target.value)}>
              <option value="all">All stages</option>
              {(data?.options.stages ?? []).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="tweaks-label">Victim percent at the first hit</span>
            <select
              className="library-filter-input"
              value={percentBand}
              onChange={(event) => setPercentBand(event.target.value)}
            >
              <option value="all">All percents</option>
              {OPENING_PERCENT_BANDS.map((band) => (
                <option key={band.key} value={band.key}>
                  {band.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="tweaks-label">Recency</span>
            <select
              className="library-filter-input"
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
            >
              {RECENCY_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  Last {value} games
                </option>
              ))}
            </select>
          </label>
        </div>

        {isLoading && (
          <div className="openings-status">
            <div className="spinner" /> Loading openings…
          </div>
        )}
        {isError && <div className="openings-status openings-status-error">Could not load the opening ledger.</div>}

        {data && !isLoading && (
          <>
            <div className="openings-summary">
              <span>
                <strong className="mono">{data.baseline.total}</strong> openings in{" "}
                <strong className="mono">{data.coverage.gamesWithOpenings}</strong> of {data.coverage.gamesInScope}{" "}
                games
              </span>
              <span>
                Kill rate <strong className="mono">{pct(data.baseline.kills, data.baseline.total)}</strong>{" "}
                <span className="openings-ratio">{ratio(data.baseline.kills, data.baseline.total)}</span>
              </span>
              <span>
                Avg damage <strong className="mono">{data.baseline.avgDamage.toFixed(1)}</strong>
              </span>
              <span>
                Avg victim percent <strong className="mono">{data.baseline.avgPercent.toFixed(0)}%</strong>
              </span>
            </div>

            {data.baseline.total > 0 && (
              <div className="openings-global-bands">
                <span className="openings-detail-heading">Victim percent at the first hit · all openings in scope</span>
                <PercentBandChart bands={data.baseline.percentBands} />
              </div>
            )}

            {missingGames > 0 && (
              <div className="openings-coverage-warning" role="status">
                {missingGames} of {data.coverage.gamesInScope} recent games predate the opening ledger. Run the backfill
                to re-parse them and include their openings.
              </div>
            )}
            {lowOverallSample && (
              <div className="openings-coverage-warning" role="status">
                Only {data.baseline.total} openings in this scope. Rates are descriptive — collect more games before
                treating them as habits.
              </div>
            )}
            {data.coverage.gamesInScope === 0 && <div className="openings-status">No games match these filters.</div>}
            {data.coverage.gamesInScope > 0 && data.baseline.total === 0 && (
              <div className="openings-status">
                No neutral openings recorded for these games yet.
                {missingGames > 0 ? " Older replays need a backfill first." : ""}
              </div>
            )}

            {data.baseline.total > 0 && (
              <>
                <div className="openings-list-header">
                  <span className="openings-list-title">Rule buckets</span>
                  <PillRow>
                    <Pill active={sort === "count"} onClick={() => setSort("count")}>
                      Most frequent
                    </Pill>
                    <Pill active={sort === "kills"} onClick={() => setSort("kills")}>
                      Most costly
                    </Pill>
                  </PillRow>
                </div>

                <div className="openings-sections">
                  {sections.map((section) => (
                    <div key={section.situation} className="openings-situation-section">
                      <div className="openings-situation-header">
                        <span className="openings-situation-name">{prettyLabel(section.situation)}</span>
                        <span className="mono">{section.total} openings</span>
                      </div>
                      {section.buckets.map((bucket) => {
                        const key = `${bucket.situation}|${bucket.openerFamily}|${bucket.openerLabel}`;
                        return (
                          <BucketRow
                            key={key}
                            bucket={bucket}
                            situationTotal={section.total}
                            dimmed={lowOverallSample || bucket.count < EVENT_SAMPLE_GUARDS.openingsBucketMin}
                            expanded={expanded === key}
                            onToggle={() => setExpanded((current) => (current === key ? null : key))}
                            onOpenExample={openExample}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>

                <div className="openings-clusters">
                  <div className="openings-list-header">
                    <span className="openings-list-title">Conversion sequences by opponent</span>
                    <span className="performance-data-note">Descriptive only · recomputed for this filter</span>
                  </div>

                  {data.clusters.status === "insufficient-sample" ? (
                    <div className="openings-clusters-note">
                      {data.clusters.reason === "n-below-25"
                        ? `Conversion sequences need ${data.clusters.required} openings in this scope — ${data.clusters.n} so far.`
                        : "No opening in this scope has a recorded conversion move list, so there are no conversion sequences to group."}
                    </div>
                  ) : (
                    <>
                      {data.clusters.groups.map((group) => (
                        <div className="openings-situation-section" key={group.opponentCharacter}>
                          <div className="openings-situation-header">
                            <span className="openings-situation-name">vs {group.opponentCharacter}</span>
                            <span className="mono">
                              {group.n} openings · {group.withSequence} with move lists
                            </span>
                          </div>
                          {group.lowSample && (
                            <div className="openings-clusters-note">
                              Only {group.n} openings against {group.opponentCharacter} in this scope. Sequences are
                              descriptive — collect more games before reading them as habits.
                            </div>
                          )}
                          {group.withoutSequence > 0 && (
                            <div className="openings-clusters-note">
                              {group.withoutSequence} of {group.n} openings have no recorded conversion move list and
                              are excluded from these sequences.
                            </div>
                          )}
                          {group.clusters.length === 0 ? (
                            <div className="openings-clusters-note">
                              No recorded conversion move lists for these openings.
                            </div>
                          ) : (
                            group.clusters.map((cluster) => {
                              const key = `${group.opponentCharacter}|${cluster.id}`;
                              return (
                                <SequenceClusterRow
                                  key={key}
                                  cluster={cluster}
                                  groupWithSequence={group.withSequence}
                                  dimmed={group.lowSample || cluster.size < EVENT_SAMPLE_GUARDS.openingsBucketMin}
                                  expanded={expanded === key}
                                  onToggle={() => setExpanded((current) => (current === key ? null : key))}
                                  onOpenExample={openExample}
                                />
                              );
                            })
                          )}
                        </div>
                      ))}
                      <p className="openings-clusters-caption">
                        Each sequence lists the opponent's damaging moves in the full conversion, in the order the
                        replay recorded them and with repeats preserved. A conversion can continue through resets and
                        tech chases, so this is not a verified true combo. Sequences seen at least{" "}
                        {EVENT_SAMPLE_GUARDS.openingsBucketMin} times stand alone; rarer continuations are grouped under
                        their first move ("side b · …"), with the number of distinct sequences shown. Percent
                        distributions use the victim's percent on the frame before the first hit; the bands are
                        descriptive, not thresholds where a conversion becomes a true combo. Labels describe observed
                        moves, not named techniques. Cluster ids are not saved and are not used as filters.
                      </p>
                    </>
                  )}
                </div>
              </>
            )}

            <p className="openings-caption">
              Low-sample buckets (under {EVENT_SAMPLE_GUARDS.openingsBucketMin} openings) are dimmed, not hidden. Shares
              compare within each situation; kill rate uses the bucket's own count.
            </p>
          </>
        )}
      </Card>
    </section>
  );
}
