export default function TopBar({ planVisible, onTogglePlan, showReset, onReset }) {
  return (
    <div className="ui-top">
      <div className="logo">
        <span className="logo__mc">
          MC<sup>2</sup>
        </span>
        <span className="logo__sub">Masdar City Square</span>
        <span className="logo__ar">مجمع مدينة مصدر</span>
      </div>
      <div className="top-actions">
        <button
          className={`tbtn${planVisible ? " is-on" : ""}`}
          type="button"
          onClick={onTogglePlan}
        >
          ◧ Plan
        </button>
        <button
          className={`tbtn${showReset ? "" : " hidden"}`}
          type="button"
          onClick={onReset}
        >
          ↺ Whole project
        </button>
      </div>
    </div>
  );
}
