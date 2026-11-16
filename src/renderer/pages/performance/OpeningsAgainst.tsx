import "./OpeningsAgainst.css";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "../../components/ui/Card";
import { Pill, PillRow } from "../../components/ui/Pill";
import { useOpeningsAgainst } from "../../hooks/queries";
import type { OpeningsAgainstFilters, OpeningsAgainstResult } from "../../../openingsAgainst";
import { EVENT_SAMPLE_GUARDS, OPENING_SITUATION_ORDER } from "../../../characterEventProfile";
import { pct, prettyLabel, ratio } from "../characters/shared";

type OpeningBucket = OpeningsAgainstResult["buckets"][number];
type OpeningExample = OpeningsAgainstResult["examples"][number];
type ClusterSummary = Extract<OpeningsAgainstResult["clusters"], { status: "ok" }>["clusters"][number];

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
              <div className="openings-bands">
                {bucket.splits.percentBands.map((band) => (
                  <div key={band.key} className="openings-band">
                    <span>{band.label}</span>
                    <span className="mono">
                      {band.count}
                      {band.kills > 0 ? ` · ${band.kills}K` : ""}
                    </span>
                  </div>
                ))}
              </div>
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

function ClusterCard({
  cluster,
  onOpenExample,
}: {
  cluster: ClusterSummary;
  onOpenExample: (example: OpeningExample) => void;
}) {
  return (
    <div className="openings-cluster-card">
      <div className="openings-cluster-head">
        <div>
          <span className="openings-cluster-label">{cluster.label}</span>
          <span className="openings-cluster-dominant">
            Mostly {prettyLabel(cluster.dominantSituation)} · {prettyLabel(cluster.dominantFamily)} ·{" "}
            {prettyLabel(cluster.dominantOpenerLabel)}
          </span>
        </div>
        <span className="openings-cluster-size mono">
          {cluster.size} · {Math.round(cluster.share * 100)}%
        </span>
      </div>
      <div className="openings-cluster-meta">
        <span>
          Percent {cluster.percentMean}% avg · {cluster.percentMedian}% median
        </span>
        <span>Distance {cluster.distanceMean}</span>
        <span>Cornered {Math.round(cluster.corneredShare * 100)}%</span>
        <span>Kill rate {Math.round(cluster.killRate * 100)}%</span>
        <span>Avg damage {cluster.avgDamage.toFixed(1)}</span>
        <span>Games {cluster.distinctGames}</span>
      </div>
      <div className="openings-example-row">
        {cluster.examples.map((example) => (
          <ExampleChip
            key={`${example.gameId}-${example.startFrame}`}
            example={example}
            onOpen={() => onOpenExample(example)}
          />
        ))}
      </div>
    </div>
  );
}

export function OpeningsAgainst() {
  const navigate = useNavigate();
  const [character, setCharacter] = useState("all");
  const [opponentCharacter, setOpponentCharacter] = useState("all");
  const [stage, setStage] = useState("all");
  const [limit, setLimit] = useState<number>(200);
  const [sort, setSort] = useState<"count" | "kills">("count");
  const [expanded, setExpanded] = useState<string | null>(null);

  const queryFilters = useMemo(() => {
    const filters: OpeningsAgainstFilters = { limit };
    if (character !== "all") filters.character = character;
    if (opponentCharacter !== "all") filters.opponentCharacter = opponentCharacter;
    if (stage !== "all") filters.stage = stage;
    return filters;
  }, [character, opponentCharacter, stage, limit]);

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
                    <span className="openings-list-title">Shape clusters</span>
                    <span className="performance-data-note">Descriptive only · recomputed for this filter</span>
                  </div>

                  {data.clusters.status === "insufficient-sample" ? (
                    <div className="openings-clusters-note">
                      {data.clusters.reason === "n-below-40"
                        ? `Shape clusters need ${data.clusters.required} openings in this scope — ${data.clusters.n} so far.`
                        : `No grouping reached the minimum cluster size of ${data.clusters.minClusterSize} openings at k 2–6.`}
                    </div>
                  ) : (
                    <>
                      {data.clusters.weakSeparation && (
                        <div className="openings-clusters-note">
                          These groups overlap (silhouette {data.clusters.silhouette.toFixed(2)}). Treat them as a rough
                          map of where openings happen, not as separate habits.
                        </div>
                      )}
                      <div className="openings-cluster-grid">
                        {data.clusters.clusters.map((cluster) => (
                          <ClusterCard key={cluster.id} cluster={cluster} onOpenExample={openExample} />
                        ))}
                      </div>
                      <p className="openings-clusters-caption">
                        Clusters use pre-hit percent, relative position, distance, stage position, and platform only.
                        Situation and move labels are assigned after clustering. Cluster ids are not saved and are not
                        used as filters.
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
