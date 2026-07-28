import { useEffect, useMemo, useState } from "react";
import { FLOORPLATES } from "../data/buildings";

function floorsFor(building) {
  const list = ["G"];
  for (let i = 1; i < building.floors; i++) list.push(`L${i}`);
  return list;
}

// Areas are illustrative: the per-level figure is derived from the building's
// GFA divided by its floor count, with the ground floor reading larger.
function areaFor(building, floor) {
  const base = Math.round(
    parseInt(building.gfa.replace(/[^0-9]/g, ""), 10) / building.floors
  );
  const area =
    floor === "G"
      ? Math.round(base * 1.15)
      : base + ((floor.charCodeAt(1) || 0) % 3) * 40 - 40;
  return area.toLocaleString();
}

export default function FloorplateModal({ building, isOpen, onClose }) {
  const floors = useMemo(() => (building ? floorsFor(building) : []), [building]);
  const defaultFloor = floors.length > 1 ? floors[1] : floors[0];
  const [floor, setFloor] = useState(defaultFloor);

  // Derived during render so the first paint — and any switch to a building
  // that doesn't have the previously-selected level — always has a valid floor.
  const activeFloor = floors.includes(floor) ? floor : defaultFloor;

  // Reset to the default level each time the dialog opens for a building.
  // Escape is handled centrally in App, which closes the modal before the panel.
  useEffect(() => {
    if (isOpen) setFloor(defaultFloor);
  }, [isOpen, defaultFloor]);

  if (!building) return <div className="modal" aria-hidden="true" />;

  return (
    <div
      className={`modal${isOpen ? " on" : ""}`}
      aria-hidden={!isOpen}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal__card" role="dialog" aria-modal="true">
        <div className="modal__head">
          <h3>{building.name} — Floorplates</h3>
          <button className="xbtn" type="button" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="floors">
          {floors.map((f) => (
            <button
              key={f}
              type="button"
              className={`fchip${f === activeFloor ? " on" : ""}`}
              onClick={() => setFloor(f)}
            >
              {f}
            </button>
          ))}
        </div>

        <div className="planwrap">
          <div className="plan">
            <img src={FLOORPLATES[building.fp || 0]} alt="Floorplate drawing" />
          </div>
          <div className="plan__meta">
            <div className="l">Selected floor</div>
            <div className="big">{areaFor(building, activeFloor)} m²</div>
            <div className="l">
              {activeFloor === "G" ? "Ground floor" : `Level ${activeFloor.slice(1)}`} ·{" "}
              {building.use}
            </div>
            <p>
              Column-free flexible floorplate — sub-divisible from one tenant to four,
              daylight to every desk, shaded roof terrace above.
            </p>
          </div>
        </div>

        <p className="modal__note">
          ▲ Real isometric floorplate from your XD source · illustrative areas per level.
        </p>
      </div>
    </div>
  );
}
