/**
 * Cleaning pipeline panel — Phase 1 renders the honest empty state only.
 * Step add/edit/enable/disable arrives in Phase 4; the button states that
 * clearly instead of opening a dead dialog.
 */
export function CleaningPanel() {
  return (
    <section className="cleaning-panel" aria-labelledby="cleaning-panel-title">
      <h2 className="cleaning-panel__title" id="cleaning-panel-title">
        Cleaning pipeline
      </h2>
      <div className="cleaning-panel__empty">
        <p>No cleaning steps yet.</p>
        <button type="button" className="btn" disabled aria-disabled="true">
          Add a step
        </button>
        <p>Cleaning steps arrive in the next development phase.</p>
      </div>
    </section>
  );
}
