export default function Tooltip({ hover }) {
  return (
    <div
      className={`tip${hover ? " on" : ""}`}
      style={hover ? { left: `${hover.x}px`, top: `${hover.y}px` } : undefined}
    >
      <div className="n">{hover?.data.name}</div>
      <div className="u">{hover?.data.use}</div>
    </div>
  );
}
