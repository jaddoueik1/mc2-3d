import { useEffect, useState } from "react";
import { USE_COLORS, IMAGES } from "../data/buildings";

export default function DetailPanel({ building, onBack, onFloorplates, onEnquire }) {
  // Keep the last building rendered while the panel slides shut.
  const [shown, setShown] = useState(building);
  useEffect(() => {
    if (building) setShown(building);
  }, [building]);

  const d = shown;
  const isOpen = Boolean(building);

  return (
    <aside className={`panel${isOpen ? " on" : ""}`} aria-hidden={!isOpen}>
      <button className="panel__back" type="button" onClick={onBack}>
        ← Back to whole project
      </button>

      {d && (
        <>
          <span className="panel__use" style={{ background: USE_COLORS[d.useKey] }}>
            {d.use}
          </span>
          <h2 className="panel__name">{d.name}</h2>
          <div
            className="panel__img"
            style={{ backgroundImage: `url('${IMAGES[d.img]}')` }}
          />
          <p className="panel__blurb">{d.blurb}</p>

          <div className="facts">
            <Fact label="Floors" value={d.floors} />
            <Fact label="GFA" value={`${d.gfa} m²`} />
            <Fact label="Availability" value={d.avail} />
            <Fact label="Height" value={`${Math.round(d.floors * 4.0)} m`} />
          </div>

          <div className="tags">
            {d.tags.map((t) => (
              <span className="tag" key={t}>{t}</span>
            ))}
          </div>

          <div className="panel__cta">
            <button className="btn btn-primary" type="button" onClick={onFloorplates}>
              Explore floorplates →
            </button>
            <button className="btn" type="button" onClick={onEnquire}>
              Enquire to lease
            </button>
          </div>

          <p className="panel__note">
            Building identities and figures are illustrative — but the floorplates and
            site plan are the real drawings from your file. Production wires exact
            leasing data per level.
          </p>
        </>
      )}
    </aside>
  );
}

function Fact({ label, value }) {
  return (
    <div className="fact">
      <div className="l">{label}</div>
      <div className="v">{value}</div>
    </div>
  );
}
