import "./ComboEnders.css";
import { useNavigate } from "react-router-dom";
import { Card } from "../../components/ui/Card";
import { KPI } from "../../components/ui/KPI";
import { DataTable } from "../../components/ui/DataTable";
import { useComboEndings } from "../../hooks/queries";
import { EVENT_SAMPLE_GUARDS } from "../../../characterEventProfile";
import type { ComboEndingSummary } from "../../../pipeline/comboEndings";
import { accentVars, pct, prettyLabel, ratio } from "./shared";
import type { CharacterModuleProps } from "./shared";

const ENDING_WINDOW = 500;

/** "fair" / "dair (aerial)" — the family tag keeps the exact move unambiguous. */
function enderLabel(row: ComboEndingSummary["enders"][number]): string {
  return `${prettyLabel(row.label)} (${prettyLabel(row.family)})`;
}

function endStateText(row: ComboEndingSummary["victimEndStates"][number]): string {
  return `${prettyLabel(row.state)} ${row.count}`;
}

function EndersTable({ summary }: { summary: ComboEndingSummary }) {
  return (
    <DataTable colWidths={[undefined, "66px", "66px", "108px", undefined]}>
      <thead>
        <tr>
          <th>Final move</th>
          <th>Endings</th>
          <th>Kills</th>
          <th>End % (middle half)</th>
          <th>Victim end state</th>
        </tr>
      </thead>
      <tbody>
        {summary.enders.map((row) => (
          <tr
            key={`${row.family}:${row.label}`}
            className={row.lowSample ? "combo-enders-row-low" : undefined}
            title={
              row.lowSample
                ? `Only ${row.count} ending${row.count === 1 ? "" : "s"} with this ender — collect more games before reading it as a habit`
                : `${row.count} endings with this ender`
            }
          >
            <td>{enderLabel(row)}</td>
            <td>{row.count}</td>
            <td>
              {pct(row.kills, row.count)} <span className="combo-enders-ratio">{ratio(row.kills, row.count)}</span>
            </td>
            <td>
              {Math.round(row.endPercentP25)}–{Math.round(row.endPercentP75)}%{" "}
              <span className="combo-enders-ratio">med {Math.round(row.endPercentMedian)}</span>
            </td>
            <td>
              <span className="combo-enders-end-states">
                {row.endStates.map((state) => endStateText(state)).join(" · ")}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

function DecisionTable({ summary }: { summary: ComboEndingSummary }) {
  const rows = summary.decisions.filter((row) => row.count > 0);
  if (rows.length === 0) return null;
  return (
    <DataTable colWidths={[undefined, "70px", "58px", "58px", "62px", "54px", "74px"]}>
      <thead>
        <tr>
          <th>First commitment</th>
          <th>Endings</th>
          <th>Punished</th>
          <th>Whiffed</th>
          <th>Extended</th>
          <th>Reset</th>
          <th>Edgeguard link</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.decision}
            className={row.lowSample ? "combo-enders-row-low" : undefined}
            title={
              row.lowSample
                ? `${row.count} endings with this decision — below the ${EVENT_SAMPLE_GUARDS.comboDecisionMin}-ending sample guard`
                : `${row.count} endings with this decision`
            }
          >
            <td>{prettyLabel(row.decision)}</td>
            <td>
              {row.count} <span className="combo-enders-ratio">{pct(row.count, summary.total)}</span>
            </td>
            <td>{row.punished > 0 ? ratio(row.punished, row.count) : "—"}</td>
            <td>{row.whiffed > 0 ? ratio(row.whiffed, row.count) : "—"}</td>
            <td>{row.extended > 0 ? ratio(row.extended, row.count) : "—"}</td>
            <td>{row.reset > 0 ? ratio(row.reset, row.count) : "—"}</td>
            <td>{row.edgeguardLinked > 0 ? ratio(row.edgeguardLinked, row.count) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

export function ComboEnders({ character, color, glowColor }: CharacterModuleProps) {
  const navigate = useNavigate();
  const { data } = useComboEndings({ character, limit: ENDING_WINDOW });
  if (!data || data.summary.total === 0) return null;

  const { summary, coverage } = data;
  const missingGames = Math.max(0, coverage.gamesInScope - coverage.gamesParsedCurrent);
  const lowSample = summary.total < EVENT_SAMPLE_GUARDS.comboEnderMin;
  const { cost, squanderedEndings } = summary;
  const topPunishOpener = cost.topPunishOpeners[0] ?? null;

  return (
    <Card title="How your combos end" className="combo-enders" style={accentVars(color, glowColor)}>
      <p className="combo-enders-intro">
        One row per conversion you landed, anchored on its final connected hit — not a verified true combo (conversions
        can include resets and tech chases). The ender is the exact final move; the post-hit decision is measured after
        your first actionable frame.
      </p>

      {missingGames > 0 && (
        <div className="combo-enders-warning" role="status">
          {missingGames} of {coverage.gamesInScope} recent {character} games predate the combo-ending ledger. Run the
          backfill to re-parse them.
        </div>
      )}
      {lowSample && (
        <div className="combo-enders-warning" role="status">
          Only {summary.total} endings in this scope. Rates are descriptive — collect more games before treating them as
          habits.
        </div>
      )}

      <div className="combo-enders-kpis">
        <KPI
          label="Endings"
          value={summary.total}
          sub={`${summary.avgMoveCount.toFixed(1)} moves · ${summary.avgDamage.toFixed(1)} damage on average`}
        />
        <KPI
          label="Kill rate"
          value={
            <span className="combo-enders-mono">
              {pct(summary.kills, summary.total)}{" "}
              <span className="combo-enders-ratio">{ratio(summary.kills, summary.total)}</span>
            </span>
          }
          sub={`End % median ${Math.round(summary.endPercentMedian)} (middle half ${Math.round(summary.endPercentP25)}–${Math.round(summary.endPercentP75)})`}
        />
        <KPI
          label="Punished after the hit"
          value={
            <span className="combo-enders-mono">
              {pct(cost.punished, summary.total)}{" "}
              <span className="combo-enders-ratio">{ratio(cost.punished, summary.total)}</span>
            </span>
          }
          sub={`${cost.avgPunishDamagePerEnding.toFixed(1)} damage taken per ending · most often by ${topPunishOpener ? prettyLabel(topPunishOpener.label) : "—"}`}
          subTone={cost.punishedShare > 0.35 ? "bad" : "neutral"}
        />
        <KPI
          label="Ended at ≥100% without the stock"
          value={
            <span className="combo-enders-mono">
              {pct(squanderedEndings.total, summary.total)}{" "}
              <span className="combo-enders-ratio">{ratio(squanderedEndings.total, summary.total)}</span>
            </span>
          }
          sub={`${squanderedEndings.total} ending${squanderedEndings.total === 1 ? "" : "s"} — a measured fact, not a missed-kill claim`}
        />
      </div>

      <div className="combo-enders-section">
        <div className="combo-enders-section-label">Victim end states</div>
        <div className="combo-enders-states">
          {summary.victimEndStates.map((state) => (
            <span key={state.state} className="combo-enders-state-chip">
              {prettyLabel(state.state)} <b className="combo-enders-mono">{state.count}</b>{" "}
              <span className="combo-enders-ratio">{pct(state.count, summary.total)}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="combo-enders-section">
        <div className="combo-enders-section-label">Enders</div>
        <EndersTable summary={summary} />
        {summary.enders.some((row) => row.lowSample) && (
          <div className="combo-enders-caption">
            Dimmed enders have fewer than {EVENT_SAMPLE_GUARDS.comboEnderMin} endings. End % is the victim's percent
            when the conversion ended (after the final hit), not a combo-validity threshold.
          </div>
        )}
      </div>

      <div className="combo-enders-section">
        <div className="combo-enders-section-label">Post-hit decisions</div>
        <DecisionTable summary={summary} />
        <div className="combo-enders-caption">
          The first commitment after your first actionable frame, within 30 frames. Outcome flags are not mutually
          exclusive; "reset" means the victim escaped with no extension, whiff, punish, or edgeguard link.
        </div>
      </div>

      {summary.examples.length > 0 && (
        <div className="combo-enders-section">
          <div className="combo-enders-section-label">Recent endings</div>
          <div className="combo-enders-examples">
            {summary.examples.map((example) => (
              <button
                key={`${example.gameId}-${example.lastHitFrame}`}
                type="button"
                className={`combo-enders-example-chip${example.didKill ? " combo-enders-example-kill" : ""}`}
                disabled={example.gameId == null}
                title={`${example.enderLabel} at ${example.endPercent}% — victim ${example.victimEndState}${
                  example.didKill ? "; this conversion took the stock" : ""
                }`}
                onClick={() => {
                  if (example.gameId == null) return;
                  navigate(`/game/${example.gameId}`, { state: { seekFrame: example.lastHitFrame } });
                }}
              >
                <span className="combo-enders-mono">{example.timestamp}</span>
                <span>{prettyLabel(example.enderLabel)}</span>
                <span className="combo-enders-mono">{Math.round(example.endPercent)}%</span>
                {example.didKill && <span className="combo-enders-example-kill-dot" aria-label="kill" />}
              </button>
            ))}
          </div>
          <div className="combo-enders-caption">Opens the game at the final hit.</div>
        </div>
      )}
    </Card>
  );
}
