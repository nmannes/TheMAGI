import "./ComboEndings.css";
import { useState } from "react";
import { Card } from "../../components/ui/Card";
import { useComboEndings } from "../../hooks/queries";
import { EVENT_SAMPLE_GUARDS } from "../../../characterEventProfile";
import type { ComboEndingSummary } from "../../../pipeline/comboEndings";
import { pct, prettyLabel, ratio } from "../characters/shared";

const RECENCY_OPTIONS = [100, 200, 500] as const;

function EnderRow({ row, total }: { row: ComboEndingSummary["enders"][number]; total: number }) {
  return (
    <div className={`combo-endings-ender${row.lowSample ? " combo-endings-dim" : ""}`}>
      <span className="combo-endings-ender-label">
        {prettyLabel(row.label)}
        <span className={`combo-endings-family combo-endings-family-${row.family}`}>{prettyLabel(row.family)}</span>
      </span>
      <span className="combo-endings-bar-track">
        <span className="combo-endings-bar-fill" style={{ width: `${Math.min(100, (row.count / total) * 100)}%` }} />
      </span>
      <span className="combo-endings-n">
        {pct(row.count, total)} <span className="combo-endings-ratio">{ratio(row.count, total)}</span>
      </span>
      <span className="combo-endings-kill">
        {pct(row.kills, row.count)} <span className="combo-endings-ratio">{ratio(row.kills, row.count)}</span>
      </span>
    </div>
  );
}

export function ComboEndings() {
  const [limit, setLimit] = useState<number>(200);
  const { data, isLoading, isError } = useComboEndings({ limit });

  const summary = data?.summary;
  const missingGames = data ? Math.max(0, data.coverage.gamesInScope - data.coverage.gamesParsedCurrent) : 0;
  const lowSample = summary != null && summary.total < EVENT_SAMPLE_GUARDS.comboEnderMin;
  const enders = summary ? summary.enders.slice(0, 5) : [];
  const squanderedEnders = summary ? summary.squanderedEndings.byEnder.slice(0, 4) : [];

  return (
    <section aria-labelledby="combo-endings-heading">
      <div className="performance-section-heading">
        <div>
          <span className="performance-eyebrow">Punish game</span>
          <h2 id="combo-endings-heading">How your combos end</h2>
        </div>
        <span className="performance-data-note">Final connected hit · exact ender · not a true-combo claim</span>
      </div>

      <Card className="combo-endings">
        <p className="combo-endings-intro">
          One row per conversion you landed. The ender is the exact final move; post-hit decisions are measured from
          your first actionable frame, and "ended at ≥100% without the stock" is a measured fact rather than a
          missed-kill claim.
        </p>

        <div className="combo-endings-filters">
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
          <div className="combo-endings-status">
            <div className="spinner" /> Loading endings…
          </div>
        )}
        {isError && (
          <div className="combo-endings-status combo-endings-status-error">Could not load the combo-ending ledger.</div>
        )}

        {data && summary && !isLoading && (
          <>
            <div className="combo-endings-summary">
              <span>
                <strong className="mono">{summary.total}</strong> endings in{" "}
                <strong className="mono">{data.coverage.gamesWithEndings}</strong> of {data.coverage.gamesInScope} games
              </span>
              <span>
                Kill rate <strong className="mono">{pct(summary.kills, summary.total)}</strong>{" "}
                <span className="combo-endings-ratio">{ratio(summary.kills, summary.total)}</span>
              </span>
              <span>
                Punished after the hit <strong className="mono">{pct(summary.cost.punished, summary.total)}</strong>{" "}
                <span className="combo-endings-ratio">{ratio(summary.cost.punished, summary.total)}</span>
              </span>
              <span>
                Ended at ≥100% without the stock{" "}
                <strong className="mono">{pct(summary.squanderedEndings.total, summary.total)}</strong>{" "}
                <span className="combo-endings-ratio">{ratio(summary.squanderedEndings.total, summary.total)}</span>
              </span>
            </div>

            {missingGames > 0 && (
              <div className="combo-endings-warning" role="status">
                {missingGames} of {data.coverage.gamesInScope} recent games predate the combo-ending ledger. Run the
                backfill to re-parse them.
              </div>
            )}
            {lowSample && (
              <div className="combo-endings-warning" role="status">
                Only {summary.total} endings in this scope. Rates are descriptive — collect more games before treating
                them as habits.
              </div>
            )}
            {data.coverage.gamesInScope === 0 && (
              <div className="combo-endings-status">No games match these filters.</div>
            )}
            {data.coverage.gamesInScope > 0 && summary.total === 0 && (
              <div className="combo-endings-status">
                No combo endings recorded for these games yet.
                {missingGames > 0 ? " Older replays need a backfill first." : ""}
              </div>
            )}

            {summary.total > 0 && (
              <>
                <div className="combo-endings-block">
                  <div className="combo-endings-block-head">
                    <span>Top enders</span>
                    <span className="combo-endings-block-note">share · kill rate</span>
                  </div>
                  {enders.map((row) => (
                    <EnderRow key={`${row.family}:${row.label}`} row={row} total={summary.total} />
                  ))}
                </div>

                <div className="combo-endings-block">
                  <div className="combo-endings-block-head">
                    <span>After the hit</span>
                    <span className="combo-endings-block-note">first commitment · outcome rate</span>
                  </div>
                  {summary.decisions
                    .filter((row) => row.count > 0)
                    .map((row) => (
                      <div
                        key={row.decision}
                        className={`combo-endings-decision${row.lowSample ? " combo-endings-dim" : ""}`}
                      >
                        <span className="combo-endings-decision-label">{prettyLabel(row.decision)}</span>
                        <span className="combo-endings-n">
                          {pct(row.count, summary.total)}{" "}
                          <span className="combo-endings-ratio">{ratio(row.count, summary.total)}</span>
                        </span>
                        <span className="combo-endings-outcomes">
                          punished <b>{pct(row.punished, row.count)}</b> · whiffed <b>{pct(row.whiffed, row.count)}</b>{" "}
                          · extended <b>{pct(row.extended, row.count)}</b>
                        </span>
                      </div>
                    ))}
                </div>

                {squanderedEnders.length > 0 && (
                  <div className="combo-endings-block">
                    <div className="combo-endings-block-head">
                      <span>Endings at ≥100% without the stock</span>
                      <span className="combo-endings-block-note">
                        {summary.squanderedEndings.total} of {summary.total}
                      </span>
                    </div>
                    {squanderedEnders.map((row) => (
                      <div key={`${row.family}:${row.label}`} className="combo-endings-squandered">
                        <span className="combo-endings-ender-label">{prettyLabel(row.label)}</span>
                        <span className="combo-endings-n">{row.count}</span>
                        <span className="combo-endings-outcomes">
                          {row.endStates.map((state) => `${prettyLabel(state.state)} ${state.count}`).join(" · ")}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            <p className="combo-endings-caption">
              Low-sample rows (under {EVENT_SAMPLE_GUARDS.comboEnderMin} endings; decisions under{" "}
              {EVENT_SAMPLE_GUARDS.comboDecisionMin}) are dimmed, not hidden. A conversion can continue through resets
              and tech chases, so an ender is the final recorded hit, not a verified true-combo finisher.
            </p>
          </>
        )}
      </Card>
    </section>
  );
}
