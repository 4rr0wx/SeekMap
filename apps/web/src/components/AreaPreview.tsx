import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import * as turf from "@turf/turf";
import type { AreaFeature, PublicConfig } from "@hideseek/shared";
import { MAP_COLORS } from "../mapTheme";

interface Props {
  area: {
    boundary: AreaFeature;
    osm: { displayName: string };
  };
  config: PublicConfig;
  excludedBoundaries?: AreaFeature[];
}

export function AreaPreview({ area, config, excludedBoundaries = [] }: Props) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;

    const hasExcluded = excludedBoundaries.length > 0;
    const allFeatures = hasExcluded ? [area.boundary, ...excludedBoundaries] : [area.boundary];
    const bounds = turf.bbox(turf.featureCollection(allFeatures));

    if (
      !Number.isFinite(bounds[0]) ||
      !Number.isFinite(bounds[1]) ||
      !Number.isFinite(bounds[2]) ||
      !Number.isFinite(bounds[3])
    ) {
      return;
    }

    const minX = bounds[0];
    const minY = bounds[1];
    const maxX = bounds[2] === minX ? minX + 0.01 : bounds[2];
    const maxY = bounds[3] === minY ? minY + 0.01 : bounds[3];

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
          ...(hasExcluded
            ? {
                "excluded-areas": {
                  type: "geojson",
                  data: turf.featureCollection(excludedBoundaries),
                },
              }
            : {}),
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
          ...(hasExcluded
            ? [
                {
                  id: "excluded-areas-fill",
                  type: "fill" as const,
                  source: "excluded-areas",
                  paint: {
                    "fill-color": "#ef4444",
                    "fill-opacity": 0.12,
                  },
                },
                {
                  id: "excluded-areas-line",
                  type: "line" as const,
                  source: "excluded-areas",
                  paint: {
                    "line-color": "#ef4444",
                    "line-width": 2,
                    "line-dasharray": [3, 2],
                  },
                },
              ]
            : []),
        ],
      },
    });

    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.fitBounds(
      [
        [minX, minY],
        [maxX, maxY],
      ],
      { padding: 26, duration: 0 },
    );

    return () => map.remove();
  }, [
    area.boundary,
    area.osm.displayName,
    config.tileAttribution,
    config.tileUrl,
    excludedBoundaries,
  ]);

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
