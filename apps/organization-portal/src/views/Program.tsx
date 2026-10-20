import { useState } from "react";
import { ApiError, type Api, type Program, type ProgramInput } from "../api";
import { int, money } from "../format";
import { Modal } from "./Modal";

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

/** "Every month on the 15th", "Every Friday", "Every other Friday". */
export function scheduleText(p: Pick<Program, "cadence" | "day_of_month" | "weekday">): string {
  if (p.cadence === "monthly") return `Every month on the ${ordinal(p.day_of_month ?? 1)}`;
  if (p.cadence === "weekly") return `Every ${WEEKDAYS[p.weekday ?? 5]}`;
  if (p.cadence === "biweekly") return `Every other ${WEEKDAYS[p.weekday ?? 5]}`;
  return "";
}
export const dateText = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

/**
 * The first window: two large cards, Fixed Benefits and Flexible Benefits. Shown right after sign-up (and any time the organization uses Change
 * Mode). Choosing Fixed opens the schedule window; choosing Flexible saves at once. With `required` it cannot be closed until a mode is chosen.
 */
export function ModePicker({ api, current, required = false, onClose, onSaved, onError }: {
  api: Api; current: Program | null; required?: boolean; onClose: () => void; onSaved: (p: Program) => void; onError: (e: unknown) => void;
}) {
  const [schedule, setSchedule] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function flexible() {
    setBusy(true); setError(null);
    try { onSaved(await api.setProgram({ mode: "flexible" })); } catch (e) { onError(e); setError("Couldn't save your choice. Try again."); } finally { setBusy(false); }
  }
  if (schedule) return <SchedulePicker api={api} current={current} onBack={() => setSchedule(false)} onSaved={onSaved} onError={onError} />;
  const on = current?.chosen ? current.mode : null;
  return (
    <Modal title="How do you want to give benefits?" onClose={onClose} locked={required || busy} wide>
      <p className="hint mode-lead">You can change this at any time.</p>
      <div className="mode-cards">
        <button type="button" className={on === "fixed" ? "mode-card on" : "mode-card"} disabled={busy} onClick={() => setSchedule(true)}>
          <span className="mode-title">Fixed Benefits{on === "fixed" && <span className="pill available">current</span>}</span>
          <span className="mode-text">Give each employee a set amount on a regular schedule. Choose monthly, weekly or every two weeks and we credit them automatically on the payment date.</span>
        </button>
        <button type="button" className={on === "flexible" ? "mode-card on" : "mode-card"} disabled={busy} onClick={() => void flexible()}>
          <span className="mode-title">Flexible Benefits{on === "flexible" && <span className="pill available">current</span>}</span>
          <span className="mode-text">Decide when and how much. Credit your employees whenever you choose, with a CSV upload or the Benefits API.</span>
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {!required && <div className="modal-actions"><button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button></div>}
    </Modal>
  );
}

/** The schedule window, on its own so it can be opened from anywhere (Edit Schedule, or after choosing Fixed): how often, and on which day. */
export function SchedulePicker({ api, current, onBack, onClose, onSaved, onError }: {
  api: Api; current: Program | null; onBack?: () => void; onClose?: () => void; onSaved: (p: Program) => void; onError: (e: unknown) => void;
}) {
  const [cadence, setCadence] = useState<"monthly" | "weekly" | "biweekly">(current?.cadence ?? "monthly");
  const [day, setDay] = useState(current?.day_of_month ?? 1);
  const [weekday, setWeekday] = useState(current?.weekday ?? 5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true); setError(null);
    const input: ProgramInput = cadence === "monthly" ? { mode: "fixed", cadence, day_of_month: day } : { mode: "fixed", cadence, weekday };
    try { onSaved(await api.setProgram(input)); }
    catch (e) { onError(e); setError(e instanceof ApiError && e.status === 400 ? "Check the schedule and try again." : "Couldn't save the schedule. Try again."); }
    finally { setBusy(false); }
  }
  const close = onClose ?? onBack ?? (() => undefined);
  return (
    <Modal title="Payment Schedule" onClose={close} locked={busy}>
      <div className="modal-form">
        <label htmlFor="cadence">How often</label>
        <select id="cadence" value={cadence} onChange={(e) => setCadence(e.target.value as typeof cadence)}>
          <option value="monthly">Monthly</option><option value="weekly">Weekly</option><option value="biweekly">Every two weeks</option>
        </select>
        {cadence === "monthly" ? (
          <>
            <label htmlFor="day">Day of the month</label>
            <select id="day" value={day} onChange={(e) => setDay(Number(e.target.value))}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{ordinal(d)}</option>)}
            </select>
            <p className="hint">Days 1 to 28, so every month has one.</p>
          </>
        ) : (
          <>
            <label htmlFor="weekday">Weekday</label>
            <select id="weekday" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
              {WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}
            </select>
            {cadence === "biweekly" && <p className="hint">Starts on the next {WEEKDAYS[weekday]}, then every two weeks.</p>}
          </>
        )}
        <p className="hint">Dates follow New York time. Each payment credits every active employee who has a fixed benefit.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save Schedule"}</button>
          {onBack && <button type="button" className="ghost" disabled={busy} onClick={onBack}>Back</button>}
          {!onBack && <button type="button" className="ghost" disabled={busy} onClick={close}>Cancel</button>}
        </div>
      </div>
    </Modal>
  );
}

/** The program at a glance on the Benefits page. */
export function ProgramCard({ program, onChangeMode, onEditSchedule }: { program: Program; onChangeMode: () => void; onEditSchedule: () => void }) {
  const fixed = program.mode === "fixed";
  return (
    <div className="card program" aria-label="Benefits program">
      <div className="card-head">
        <h2>Benefits Program <span className={`pill ${fixed ? "available" : "closed"}`}>{fixed ? "fixed" : "flexible"}</span></h2>
        <div className="row">
          {fixed && <button type="button" className="ghost small" onClick={onEditSchedule}>Edit Schedule</button>}
          <button type="button" className="ghost small" onClick={onChangeMode}>Change Mode</button>
        </div>
      </div>
      {fixed ? (
        <>
          <p className="program-line"><strong>{scheduleText(program)}</strong>{program.next_run_date && <> • Next payment <strong>{dateText(program.next_run_date)}</strong></>}</p>
          <p className="muted">{program.fixed.employees === 0
            ? "No employee has a fixed benefit yet. Add them on the Employees page."
            : `${int(program.fixed.employees)} employee${program.fixed.employees === 1 ? "" : "s"} • ${money(program.fixed.total)} each payment`}</p>
          {program.fixed.employees > 0 && (program.funded
            ? <p className="program-ok">Your wallet covers the next payment.</p>
            : <p className="error" role="alert">Your wallet is {money(program.fixed.total - program.balance)} short for the next payment. Add funds before then.</p>)}
        </>
      ) : (
        <p className="muted">Credit your employees whenever you choose, with a CSV upload below or the Benefits API.</p>
      )}
    </div>
  );
}
