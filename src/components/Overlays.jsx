export function Hint({ hidden }) {
  return (
    <div className={`hint${hidden ? " hidden" : ""}`}>
      <b>Click a building</b> to dive into its design · drag to orbit
    </div>
  );
}

export function Legend({ hidden }) {
  return (
    <div className={`legend${hidden ? " hidden" : ""}`}>
      <div className="legend__t">Masdar City Square</div>
      <div className="row">Grade-A offices &amp; retail spine</div>
      <div className="row">
        <i style={{ background: "#3a5a86" }} /> Two solar-canopy landmarks
      </div>
      <div className="row" style={{ color: "var(--muted)", marginTop: 2 }}>
        Click any building to explore
      </div>
    </div>
  );
}

export function Toast({ message }) {
  return <div className={`toast${message ? " on" : ""}`}>{message}</div>;
}

export function Loader({ gone }) {
  return (
    <div className={`loader${gone ? " gone" : ""}`}>
      <div className="loader__mc">
        MC<sup>2</sup>
      </div>
      <div className="spin" />
      <div>Loading the model</div>
    </div>
  );
}
