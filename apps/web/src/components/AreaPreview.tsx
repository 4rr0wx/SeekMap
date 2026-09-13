import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import * as turf from "@turf/turf";
import type { PublicConfig, SearchAreaResult } from "@hideseek/shared";
import { MAP_COLORS } from "../mapTheme";

interface Props {
  area: SearchAreaResult;
  config: PublicConfig;
}

export function AreaPreview({ area, config }: Props) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;

    const bounds = turf.bbox(area.boundary);
    const map = new maplibregl.Map({
      container: container.current,
      interactive: false,
      attributionControl: false,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: [config.tileUrl],
            tileSize: 256,
            attribution: config.tileAttribution,
          },
          "selected-area": {
            type: "geojson",
            data: area.boundary,
          },
        },
        layers: [
          {
            id: "osm",
            type: "raster",
            source: "osm",
            paint: {
              "raster-saturation": -0.65,
              "raster-contrast": 0.08,
              "raster-brightness-max": 0.82,
            },
          },
          {
            id: "selected-area-fill",
            type: "fill",
            source: "selected-area",
            paint: {
              "fill-color": MAP_COLORS.possibleFill,
              "fill-opacity": MAP_COLORS.possibleFillOpacity,
            },
          },
          {
            id: "selected-area-line",
            type: "line",
            source: "selected-area",
            paint: {
              "line-color": MAP_COLORS.possibleLine,
              "line-width": MAP_COLORS.possibleLineWidth,
            },
          },
        ],
      },
    });

    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      { padding: 26, duration: 0 },
    );

    return () => map.remove();
  }, [area, config.tileAttribution, config.tileUrl]);

  return (
    <figure className="area-preview">
      <figcaption>
        <span>Selected game area</span>
        <strong>{area.osm.displayName}</strong>
      </figcaption>
      <div ref={container} className="area-preview-map" aria-label="Selected game area preview" />
    </figure>
  );
}
