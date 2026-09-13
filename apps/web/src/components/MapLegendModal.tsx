import { Layers3, ShieldCheck, X } from "lucide-react";
import { MAP_LEGEND_SECTIONS, type LegendItem, type LegendSection } from "../mapTheme";

interface Props {
  onClose: () => void;
  onOpenLayers?: () => void;
}

function SwatchPreview({ item }: { item: LegendItem }) {
  const { swatch, type } = item;

  if (type === "area") {
    return (
      <div
        className="map-legend-swatch area"
        style={{
          backgroundColor: swatch.fill,
          borderColor: swatch.stroke,
          borderWidth: `${swatch.strokeWidth ?? 2}px`,
          borderStyle: swatch.dashed ? "dashed" : "solid",
        }}
        aria-hidden="true"
      />
    );
  }

  if (type === "line") {
    return (
      <div className="map-legend-swatch line" aria-hidden="true">
        <span
          style={{
            borderColor: swatch.stroke,
            borderTopWidth: `${swatch.strokeWidth ?? 2.5}px`,
            borderTopStyle: swatch.dashed ? "dashed" : "solid",
          }}
        />
      </div>
    );
  }

  return (
    <div className="map-legend-swatch point" aria-hidden="true">
      <span
        className={swatch.glow ? "point-dot glow" : "point-dot"}
        style={{
          backgroundColor: swatch.pointFill,
          borderColor: swatch.pointStroke,
        }}
      />
    </div>
  );
}

export function MapLegendModal({ onClose, onOpenLayers }: Props) {
  return (
    <div className="modal-backdrop align-end" onClick={onClose}>
      <section
        className="sheet legend-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="map-legend-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-header">
          <div>
            <p className="eyebrow">Universal Map Key</p>
            <h2 id="map-legend-title">Map Guide & Legend</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close legend">
            <X />
          </button>
        </div>

        <p className="legend-subtitle">
          How to read every region, question shape, transit route, and marker displayed on your
          board.
        </p>

        <div className="legend-sections">
          {MAP_LEGEND_SECTIONS.map((section: LegendSection) => (
            <div className="legend-section" key={section.id}>
              <h3>{section.title}</h3>
              <div className="legend-items">
                {section.items.map((item: LegendItem) => (
                  <div className="legend-row" key={item.id}>
                    <SwatchPreview item={item} />
                    <div className="legend-text">
                      <strong>{item.label}</strong>
                      <p>{item.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="legend-footer">
          {onOpenLayers && (
            <button type="button" className="button secondary wide" onClick={onOpenLayers}>
              <Layers3 size={17} />
              Configure visible layers
            </button>
          )}
          <div className="legend-privacy-note">
            <ShieldCheck size={16} />
            <span>
              <strong>Hider Privacy:</strong> Your GPS location is computed locally in your browser
              and is never transmitted to the server or other players.
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
