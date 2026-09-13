import { useEffect, useMemo, useRef } from "react";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";
import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Geometry, Point } from "geojson";
import {
  thermometerDivider,
  type GameState,
  type MapFeature,
  type MapFeatureCollection,
  type PublicConfig,
} from "@hideseek/shared";
import { MAP_COLORS } from "../mapTheme";

export interface MapLayers {
  possibleArea: boolean;
  questionGeometry: boolean;
  administrative: boolean;
  transitLines: boolean;
  transitStations: boolean;
  datasets: boolean;
  markers: boolean;
}

interface Props {
  state: GameState;
  config: PublicConfig;
  layers: MapLayers;
  localPosition: [number, number] | null;
  measurement: [number, number][];
  draftQuestionActive: boolean;
  draftQuestionPoints: Partial<Record<"A" | "B", [number, number]>>;
  draftQuestionGeometry: MapFeatureCollection | MapFeature | null;
  selectedQuestionId: string | null;
  interactionActive: boolean;
  onMapClick: (point: [number, number]) => void;
}

const empty: FeatureCollection = { type: "FeatureCollection", features: [] };

function collection(features: Array<Feature<Geometry> | null | undefined>): FeatureCollection {
  return { type: "FeatureCollection", features: features.filter(Boolean) as Feature<Geometry>[] };
}

function setData(map: MapLibreMap, source: string, data: FeatureCollection | Feature<Geometry>) {
  (map.getSource(source) as GeoJSONSource | undefined)?.setData(data);
}

function visibility(map: MapLibreMap, layer: string, visible: boolean) {
  if (map.getLayer(layer)) map.setLayoutProperty(layer, "visibility", visible ? "visible" : "none");
}

function applyLayerVisibility(map: MapLibreMap, layers: MapLayers, questionFocused = false) {
  visibility(map, "possible-fill", layers.possibleArea);
  visibility(map, "possible-line", layers.possibleArea && !questionFocused);
  visibility(map, "question-fill", layers.questionGeometry);
  visibility(map, "question-line", layers.questionGeometry);
  visibility(map, "question-divider-line", layers.questionGeometry);
  visibility(map, "question-point", layers.questionGeometry);
  visibility(map, "admin-line", layers.administrative);
  visibility(map, "transit-line", layers.transitLines);
  visibility(map, "station-circle", layers.transitStations);
  visibility(map, "dataset-fill", layers.datasets);
  visibility(map, "dataset-line", layers.datasets);
  visibility(map, "dataset-point", layers.datasets);
  visibility(map, "marker-circle", layers.markers);
}

export function GameMap({
  state,
  config,
  layers,
  localPosition,
  measurement,
  draftQuestionActive,
  draftQuestionPoints,
  draftQuestionGeometry,
  selectedQuestionId,
  interactionActive,
  onMapClick,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const onClickRef = useRef(onMapClick);
  const layersRef = useRef(layers);
  const questionFocusedRef = useRef(false);
  onClickRef.current = onMapClick;
  layersRef.current = layers;

  const selectedQuestion = selectedQuestionId
    ? state.questions.find((question) => question.id === selectedQuestionId)
    : null;
  const questionFocused =
    draftQuestionActive || Boolean(selectedQuestion && selectedQuestion.status !== "APPLIED");
  questionFocusedRef.current = questionFocused;

  const visibleStations = useMemo(() => {
    const source = state.game.transitStations;
    if (!source || !state.game.possibleArea) return empty as FeatureCollection<Point>;
    return turf.featureCollection(
      source.features.filter((station) =>
        turf.booleanPointInPolygon(station, state.game.possibleArea!),
      ),
    );
  }, [state.game.transitStations, state.game.possibleArea]);

  const importedDatasets = useMemo(
    () => turf.featureCollection(state.datasets.flatMap((dataset) => dataset.geojson.features)),
    [state.datasets],
  );

  const liveDraftPoints = useMemo(
    () =>
      collection(
        (["A", "B"] as const).map((target) => {
          const point = draftQuestionPoints[target];
          return point ? turf.point(point, { draftTarget: target }) : null;
        }),
      ),
    [draftQuestionPoints],
  );

  const questionGeometry = useMemo(() => {
    const persisted = draftQuestionActive
      ? []
      : state.questions
          .filter(
            (question) =>
              question.enabled &&
              question.visualization &&
              (!selectedQuestionId || question.id === selectedQuestionId),
          )
          .map((question) => {
            const visual = question.visualization;
            if (!visual) return null;
            if (visual.type === "FeatureCollection") {
              return visual.features.map((feature) => ({
                ...feature,
                properties: {
                  ...(feature.properties ?? {}),
                  questionId: question.id,
                  selected: question.id === selectedQuestionId,
                  status: question.status,
                },
              }));
            }
            return {
              ...visual,
              properties: {
                ...(visual.properties ?? {}),
                questionId: question.id,
                selected: question.id === selectedQuestionId,
                status: question.status,
              },
            };
          })
          .flat();
    const draftFeatures = !draftQuestionGeometry
      ? []
      : draftQuestionGeometry.type === "FeatureCollection"
        ? draftQuestionGeometry.features
        : [draftQuestionGeometry];
    const preview = draftFeatures.map((feature) => ({
      ...feature,
      properties: {
        ...(feature.properties ?? {}),
        questionId: "draft-preview",
        selected: true,
        preview: true,
        status: "DRAFT",
      },
    }));
    const start = draftQuestionPoints.A;
    const end = draftQuestionPoints.B;
    const thermometerFallback =
      draftQuestionActive && start && end && draftFeatures.length === 0
        ? [
            turf.lineString([start, end], {
              artifactRole: "reference-line",
              selected: true,
              preview: true,
            }),
            {
              ...thermometerDivider(state.game.boundary, start, end),
              properties: { artifactRole: "decision-boundary", selected: true, preview: true },
            },
          ]
        : [];
    return collection([...persisted, ...preview, ...thermometerFallback]);
  }, [
    state.game.boundary,
    state.questions,
    selectedQuestionId,
    draftQuestionActive,
    draftQuestionGeometry,
    draftQuestionPoints,
  ]);

  useEffect(() => {
    if (!container.current || mapRef.current) return;
    const center = turf.centroid(state.game.boundary).geometry.coordinates as [number, number];
    const map = new maplibregl.Map({
      container: container.current,
      center,
      zoom: 9,
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
        },
        layers: [
          {
            id: "osm",
            type: "raster",
            source: "osm",
            paint: { "raster-saturation": -0.45, "raster-brightness-max": 0.86 },
          },
        ],
      },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.on("load", () => {
      const sources = [
        "boundary",
        "possible",
        "questions",
        "admin",
        "transit-lines",
        "transit-stations",
        "datasets",
        "markers",
        "local-position",
        "measurement",
        "question-draft-point",
      ];
      for (const source of sources) map.addSource(source, { type: "geojson", data: empty });
      map.addLayer({
        id: "boundary-fill",
        type: "fill",
        source: "boundary",
        paint: {
          "fill-color": MAP_COLORS.boundaryFill,
          "fill-opacity": MAP_COLORS.boundaryFillOpacity,
        },
      });
      map.addLayer({
        id: "boundary-line",
        type: "line",
        source: "boundary",
        paint: {
          "line-color": MAP_COLORS.boundaryLine,
          "line-width": MAP_COLORS.boundaryLineWidth,
        },
      });
      map.addLayer({
        id: "possible-fill",
        type: "fill",
        source: "possible",
        paint: {
          "fill-color": MAP_COLORS.possibleFill,
          "fill-opacity": MAP_COLORS.possibleFillOpacity,
        },
      });
      map.addLayer({
        id: "possible-line",
        type: "line",
        source: "possible",
        paint: {
          "line-color": MAP_COLORS.possibleLine,
          "line-width": MAP_COLORS.possibleLineWidth,
        },
      });
      map.addLayer({
        id: "admin-line",
        type: "line",
        source: "admin",
        paint: {
          "line-color": MAP_COLORS.adminLine,
          "line-width": MAP_COLORS.adminLineWidth,
          "line-dasharray": [...MAP_COLORS.adminLineDash],
        },
      });
      map.addLayer({
        id: "transit-line",
        type: "line",
        source: "transit-lines",
        paint: {
          "line-color": MAP_COLORS.transitLine,
          "line-width": MAP_COLORS.transitLineWidth,
          "line-opacity": MAP_COLORS.transitLineOpacity,
        },
      });
      map.addLayer({
        id: "question-fill",
        type: "fill",
        source: "questions",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: {
          "fill-color": [
            "case",
            ["==", ["get", "artifactRole"], "answer-region"],
            MAP_COLORS.questionAnswerFill,
            ["get", "selected"],
            MAP_COLORS.questionSelectedFill,
            MAP_COLORS.questionDefaultFill,
          ],
          "fill-opacity": [
            "case",
            ["==", ["get", "artifactRole"], "candidate-region"],
            MAP_COLORS.questionCandidateFillOpacity,
            ["==", ["get", "artifactRole"], "answer-region"],
            MAP_COLORS.questionAnswerFillOpacity,
            ["get", "selected"],
            MAP_COLORS.questionSelectedFillOpacity,
            MAP_COLORS.questionDefaultFillOpacity,
          ],
        },
      });
      map.addLayer({
        id: "question-line",
        type: "line",
        source: "questions",
        filter: [
          "all",
          ["!=", ["get", "artifactRole"], "decision-boundary"],
          ["!=", ["get", "artifactRole"], "candidate-region"],
        ],
        paint: {
          "line-color": [
            "case",
            ["==", ["get", "artifactRole"], "answer-region"],
            MAP_COLORS.questionAnswerLine,
            ["get", "selected"],
            MAP_COLORS.questionSelectedLine,
            MAP_COLORS.questionDefaultLine,
          ],
          "line-width": [
            "case",
            ["==", ["get", "artifactRole"], "answer-region"],
            MAP_COLORS.questionAnswerLineWidth,
            ["get", "selected"],
            MAP_COLORS.questionSelectedLineWidth,
            MAP_COLORS.questionDefaultLineWidth,
          ],
        },
      });
      map.addLayer({
        id: "question-divider-line",
        type: "line",
        source: "questions",
        filter: [
          "in",
          ["get", "artifactRole"],
          ["literal", ["decision-boundary", "candidate-region"]],
        ],
        paint: {
          "line-color": MAP_COLORS.questionDividerLine,
          "line-width": MAP_COLORS.questionDividerLineWidth,
          "line-dasharray": [...MAP_COLORS.questionDividerDash],
        },
      });
      map.addLayer({
        id: "question-point",
        type: "circle",
        source: "questions",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": [
            "case",
            ["==", ["get", "artifactRole"], "dataset-place"],
            MAP_COLORS.datasetPointRadius,
            MAP_COLORS.pointRadius,
          ],
          "circle-color": [
            "case",
            ["==", ["get", "artifactRole"], "thermometer-start"],
            MAP_COLORS.pointStartA,
            ["==", ["get", "artifactRole"], "thermometer-end"],
            MAP_COLORS.pointEndB,
            ["==", ["get", "artifactRole"], "seeker-reference"],
            MAP_COLORS.pointStartA,
            ["==", ["get", "artifactRole"], "dataset-place"],
            MAP_COLORS.datasetPoint,
            MAP_COLORS.questionDefaultLine,
          ],
          "circle-opacity": ["case", ["==", ["get", "artifactRole"], "dataset-place"], 0.85, 1],
          "circle-stroke-color": [
            "case",
            ["==", ["get", "artifactRole"], "dataset-place"],
            MAP_COLORS.datasetPointStroke,
            MAP_COLORS.pointStartAStroke,
          ],
          "circle-stroke-width": [
            "case",
            ["==", ["get", "artifactRole"], "dataset-place"],
            MAP_COLORS.datasetPointStrokeWidth,
            MAP_COLORS.pointStrokeWidth,
          ],
        },
      });
      map.addLayer({
        id: "station-circle",
        type: "circle",
        source: "transit-stations",
        paint: {
          "circle-radius": MAP_COLORS.stationRadius,
          "circle-color": MAP_COLORS.stationFill,
          "circle-stroke-color": MAP_COLORS.stationStroke,
          "circle-stroke-width": MAP_COLORS.stationStrokeWidth,
        },
      });
      map.addLayer({
        id: "dataset-fill",
        type: "fill",
        source: "datasets",
        paint: {
          "fill-color": MAP_COLORS.datasetFill,
          "fill-opacity": MAP_COLORS.datasetFillOpacity,
        },
      });
      map.addLayer({
        id: "dataset-line",
        type: "line",
        source: "datasets",
        paint: {
          "line-color": MAP_COLORS.datasetLine,
          "line-width": MAP_COLORS.datasetLineWidth,
        },
      });
      map.addLayer({
        id: "dataset-point",
        type: "circle",
        source: "datasets",
        paint: {
          "circle-radius": MAP_COLORS.datasetPointRadius,
          "circle-color": MAP_COLORS.datasetPoint,
          "circle-stroke-color": MAP_COLORS.datasetPointStroke,
          "circle-stroke-width": MAP_COLORS.datasetPointStrokeWidth,
        },
      });
      map.addLayer({
        id: "marker-circle",
        type: "circle",
        source: "markers",
        paint: {
          "circle-radius": MAP_COLORS.seekerMarkerRadius,
          "circle-color": MAP_COLORS.seekerMarkerFill,
          "circle-stroke-color": MAP_COLORS.seekerMarkerStroke,
          "circle-stroke-width": MAP_COLORS.seekerMarkerStrokeWidth,
        },
      });
      map.addLayer({
        id: "measurement-line",
        type: "line",
        source: "measurement",
        paint: {
          "line-color": MAP_COLORS.measurementLine,
          "line-width": MAP_COLORS.measurementLineWidth,
          "line-dasharray": [...MAP_COLORS.measurementLineDash],
        },
      });
      map.addLayer({
        id: "question-draft-point",
        type: "circle",
        source: "question-draft-point",
        paint: {
          "circle-radius": 9.5,
          "circle-color": [
            "case",
            ["==", ["get", "draftTarget"], "A"],
            MAP_COLORS.pointStartA,
            MAP_COLORS.pointEndB,
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 3,
        },
      });
      map.addLayer({
        id: "local-position",
        type: "circle",
        source: "local-position",
        paint: {
          "circle-radius": MAP_COLORS.localGpsRadius,
          "circle-color": MAP_COLORS.localGpsFill,
          "circle-stroke-color": MAP_COLORS.localGpsStroke,
          "circle-stroke-width": MAP_COLORS.localGpsStrokeWidth,
        },
      });
      setData(map, "boundary", state.game.boundary);
      setData(map, "possible", state.game.possibleArea ?? empty);
      setData(map, "questions", questionGeometry);
      setData(map, "admin", state.game.subdivisions ?? empty);
      setData(map, "transit-lines", state.game.transitLines ?? empty);
      setData(map, "transit-stations", visibleStations);
      setData(map, "datasets", importedDatasets);
      setData(
        map,
        "markers",
        collection((state.seekerMarkers ?? []).map((marker) => marker.position)),
      );
      setData(map, "local-position", localPosition ? turf.point(localPosition) : empty);
      setData(map, "question-draft-point", liveDraftPoints);
      applyLayerVisibility(map, layersRef.current, questionFocusedRef.current);
      const bounds = turf.bbox(state.game.boundary);
      map.fitBounds(
        [
          [bounds[0], bounds[1]],
          [bounds[2], bounds[3]],
        ],
        { padding: 42, duration: 0 },
      );
      map.fire("hideseek-ready");
    });
    map.on("click", (event) => onClickRef.current([event.lngLat.lng, event.lngLat.lat]));
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [config.tileAttribution, config.tileUrl, state.game.boundary]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    setData(map, "boundary", state.game.boundary);
    setData(map, "possible", state.game.possibleArea ?? empty);
    setData(map, "questions", questionGeometry);
    setData(map, "admin", state.game.subdivisions ?? empty);
    setData(map, "transit-lines", state.game.transitLines ?? empty);
    setData(map, "transit-stations", visibleStations);
    setData(map, "datasets", importedDatasets);
    setData(
      map,
      "markers",
      collection((state.seekerMarkers ?? []).map((marker) => marker.position)),
    );
    setData(map, "local-position", localPosition ? turf.point(localPosition) : empty);
    setData(map, "question-draft-point", liveDraftPoints);
    setData(map, "measurement", measurement.length === 2 ? turf.lineString(measurement) : empty);
    applyLayerVisibility(map, layers, questionFocused);
  }, [
    state,
    layers,
    localPosition,
    draftQuestionPoints,
    liveDraftPoints,
    measurement,
    questionGeometry,
    questionFocused,
    visibleStations,
    importedDatasets,
  ]);

  return (
    <div
      ref={container}
      className={interactionActive ? "map interaction-active" : "map"}
      aria-label="Game map"
    />
  );
}
